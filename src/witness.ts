import type Database from 'better-sqlite3';
import type { Provider, VkeyWitnessSet } from '@biglup/cometa';
import type { Logger } from 'pino';
import { recordAudit } from './audit.js';
import { Cometa } from './cometa.js';
import type { Config } from './config.js';
import {
  InvalidTransactionError,
  LeaseConsumedError,
  LeaseExpiredError,
  LeaseReleasedError,
  QuotaExceededError,
  type ServiceError,
  UnknownLeaseError,
} from './http/errors.js';
import type { ApiKey } from './keys.js';
import { parseTransaction, resolveInputs } from './policy/parse.js';
import { type PolicyContext, type Violation, applyPolicy } from './policy/rules.js';
import type { Lease, LeaseService } from './pool/leases.js';
import { parseUtxoRef } from './pool/utxo.js';
import type { ServiceWallet } from './wallet.js';

/** The witness set issued for a lease, as the API returns it. */
export interface IssuedWitness {
  leaseId: string;
  witnessSet: string;
}

/** The witness service: checks a client's transaction against the policy and signs the sponsor's inputs. */
export interface WitnessService {
  /** Issues the lease's witness set for the transaction, or refuses it naming the rule that failed. */
  issue(apiKey: ApiKey, leaseId: string, transaction: string): Promise<IssuedWitness>;
}

/** The tunables the policy depends on. */
export type WitnessSettings = Pick<Config, 'accountScriptHash' | 'maxSponsoredLovelace' | 'maxFeeLovelace' | 'validityMarginSeconds' | 'slots'>;

/** Everything the witness service needs injected; `now` lets tests move the clock the validity bounds are measured against. */
export interface WitnessServiceDependencies {
  db: Database.Database;
  provider: Provider;
  serviceWallet: ServiceWallet;
  leases: LeaseService;
  settings: WitnessSettings;
  now?: () => Date;
  logger?: Logger;
}

/** The CBOR map key of the verification key witnesses within a transaction witness set. */
const VKEY_WITNESSES_KEY = 0;

/** The length in bytes of a key hash. */
const KEY_HASH_BYTES = 28;

/** The hash of a verification key, as a credential names it. */
const keyHashOf = (vkey: string): string => Cometa.uint8ArrayToHex(Cometa.Blake2b.computeHash(Cometa.hexToUint8Array(vkey), KEY_HASH_BYTES));

/**
 * The CBOR of a transaction witness set holding only verification key
 * witnesses, which is what a client appends to its transaction.
 */
const encodeVkeyWitnessSet = (witnesses: VkeyWitnessSet): string => {
  const writer = new Cometa.CborWriter();
  writer.startMap(1).writeUnsignedInt(VKEY_WITNESSES_KEY).startArray(witnesses.length);
  for (const witness of witnesses) {
    writer.startArray(2).writeByteString(Cometa.hexToUint8Array(witness.vkey)).writeByteString(Cometa.hexToUint8Array(witness.signature));
  }
  return writer.encodeHex();
};

/**
 * Creates the witness service. A request walks the lease state machine
 * first: an unknown lease is refused, an expired or released one too,
 * and a consumed one answers with the witness set it already issued when
 * the transaction is the same, or refuses a different one; each of these
 * refusals is written to the audit trail under the lease's state. An open lease
 * has its transaction parsed, the key's hourly witness quota checked, its
 * inputs resolved through the provider and the policy applied in rule
 * order; only a transaction that passes every rule, and whose sponsored
 * lovelace fits in what the key's daily quota still allows, is signed.
 * Both quotas count witnesses actually issued, so a witness set answered
 * again for the same transaction counts once; the lease service measures
 * them, here ahead of the provider calls so a key over quota costs
 * nothing, and again in the step that consumes the lease, where the
 * bound is final. The wallet signs with every
 * key of its own the transaction asks for, so the witness set it returns
 * is checked to be the sponsor payment key's signature and nothing else
 * before it leaves; anything more is refused as if the policy had caught
 * it. The lease is consumed in the same step that records the witness; a
 * lease found consumed by then, as when two requests race, answers the
 * witness set already recorded when the transaction is the same. Every
 * decision is written to the audit trail with the transaction hash, never
 * its body.
 */
export const createWitnessService = ({
  db,
  provider,
  serviceWallet,
  leases,
  settings,
  now = () => new Date(),
  logger,
}: WitnessServiceDependencies): WitnessService => {
  const knowsUtxo = db.prepare('SELECT 1 FROM pool_utxos WHERE tx_hash = ? AND tx_index = ?');

  /** What the policy knows when it checks a transaction against this lease, as of now. */
  const policyContext = (lease: Lease): PolicyContext => ({
    sponsor: { address: serviceWallet.address, paymentKeyHash: serviceWallet.paymentKeyHash, stakeKeyHash: serviceWallet.stakeKeyHash },
    accountScriptHash: settings.accountScriptHash,
    lease: { fee: lease.fee, collateral: lease.collateral, expiresAt: lease.expiresAt },
    limits: {
      maxSponsoredLovelace: settings.maxSponsoredLovelace,
      maxFeeLovelace: settings.maxFeeLovelace,
      validityMarginSeconds: settings.validityMarginSeconds,
    },
    slots: settings.slots,
    now: now(),
    isSponsorUtxo: (ref) => {
      const { txHash, index } = parseUtxoRef(ref);
      return knowsUtxo.get(txHash, index) !== undefined;
    },
  });

  /** Refuses the transaction under a policy rule and records the refusal; the lease stays open for a later attempt. */
  const refuse = (apiKey: ApiKey, lease: Lease, txHash: string | undefined, violation: Violation): never => {
    recordAudit(db, {
      apiKeyId: apiKey.id,
      action: 'witness',
      outcome: violation.rule,
      detail: { leaseId: lease.id, txHash: txHash ?? null, rule: violation.rule, reason: violation.detail },
    });
    throw new InvalidTransactionError(violation.rule, violation.detail);
  };

  /** Records a refusal under a quota and rethrows it; the lease stays open for a later attempt. */
  const refuseQuota = (apiKey: ApiKey, lease: Lease, txHash: string, error: QuotaExceededError): never => {
    recordAudit(db, {
      apiKeyId: apiKey.id,
      action: 'witness',
      outcome: error.code,
      detail: { leaseId: lease.id, txHash, quota: error.quota, reason: error.detail },
    });
    throw error;
  };

  /** The key may still obtain a witness, sponsoring `sponsoredLovelace` once the policy has established it. */
  const checkQuotas = (apiKey: ApiKey, lease: Lease, txHash: string, sponsoredLovelace?: bigint): void => {
    const shortfall = leases.witnessQuotaShortfall(apiKey, sponsoredLovelace === undefined ? undefined : Number(sponsoredLovelace));
    if (shortfall !== undefined) {
      refuseQuota(apiKey, lease, txHash, new QuotaExceededError(shortfall.quota, shortfall.detail));
    }
  };

  /** The audit outcome a refusal by the lease's state is recorded under: the state itself, or the lease being unknown. */
  const leaseOutcome = (error: ServiceError): string => {
    if (error instanceof LeaseReleasedError) {
      return 'lease_released';
    }
    if (error instanceof LeaseExpiredError) {
      return 'lease_expired';
    }
    if (error instanceof LeaseConsumedError) {
      return 'lease_consumed';
    }
    return error.code;
  };

  /** Records a refusal by the lease's state and rethrows it; nothing about the lease changes. */
  const refuseLease = (apiKey: ApiKey, leaseId: string, txHash: string | undefined, error: ServiceError): never => {
    recordAudit(db, {
      apiKeyId: apiKey.id,
      action: 'witness',
      outcome: leaseOutcome(error),
      detail: { leaseId, txHash: txHash ?? null, reason: error.detail ?? error.code },
    });
    throw error;
  };

  /** The witness set a consumed lease already issued for this very transaction, or the refusal of a different one. */
  const reissue = (apiKey: ApiKey, leaseId: string, txHash: string): IssuedWitness => {
    const issued = leases.witnessOf(leaseId);
    if (issued === undefined || issued.txHash !== txHash) {
      return refuseLease(apiKey, leaseId, txHash, new LeaseConsumedError(leaseId));
    }
    recordAudit(db, { apiKeyId: apiKey.id, action: 'witness', outcome: 'reissued', detail: { leaseId, txHash } });
    return { leaseId, witnessSet: issued.witnessSet };
  };

  /** The lease the key holds under the id, or the audited refusal of an id it does not. */
  const findLease = (apiKey: ApiKey, leaseId: string): Lease => {
    try {
      return leases.find(apiKey, leaseId);
    } catch (err) {
      if (err instanceof UnknownLeaseError) {
        return refuseLease(apiKey, leaseId, undefined, err);
      }
      throw err;
    }
  };

  const issue = async (apiKey: ApiKey, leaseId: string, transaction: string): Promise<IssuedWitness> => {
    leases.expireStale();
    const lease = findLease(apiKey, leaseId);
    if (lease.status === 'expired') {
      return refuseLease(apiKey, leaseId, undefined, new LeaseExpiredError(leaseId));
    }
    if (lease.status === 'released') {
      return refuseLease(apiKey, leaseId, undefined, new LeaseReleasedError(leaseId));
    }

    const parsed = parseTransaction(transaction);
    if (parsed.violation !== undefined) {
      return refuse(apiKey, lease, undefined, parsed.violation);
    }
    const tx = parsed.transaction;

    if (lease.status === 'consumed') {
      return reissue(apiKey, leaseId, tx.hash);
    }

    checkQuotas(apiKey, lease, tx.hash);
    const resolved = await resolveInputs(provider, tx.inputs);
    if (resolved.violation !== undefined) {
      return refuse(apiKey, lease, tx.hash, resolved.violation);
    }
    const verdict = await applyPolicy(tx, resolved.inputs, policyContext(lease), provider);
    if (verdict.violation !== undefined) {
      return refuse(apiKey, lease, tx.hash, verdict.violation);
    }
    checkQuotas(apiKey, lease, tx.hash, verdict.sponsoredLovelace);

    const witnesses = await serviceWallet.wallet.signTransaction(tx.cbor, true);
    const only = witnesses.length === 1 ? witnesses[0] : undefined;
    if (only === undefined || keyHashOf(only.vkey) !== serviceWallet.paymentKeyHash) {
      return refuse(apiKey, lease, tx.hash, {
        rule: 'signers',
        detail: `Signing produced ${witnesses.length} witnesses where only the sponsor payment key may sign`,
      });
    }
    const witnessSet = encodeVkeyWitnessSet(witnesses);
    const sponsoredLovelace = Number(verdict.sponsoredLovelace);
    const invalidHereafter = Number(verdict.invalidHereafter);
    try {
      leases.consume(apiKey, lease, { txHash: tx.hash, sponsoredLovelace, witnessSet, invalidHereafter });
    } catch (err) {
      if (err instanceof LeaseConsumedError) {
        return reissue(apiKey, leaseId, tx.hash);
      }
      if (err instanceof LeaseExpiredError) {
        return refuseLease(apiKey, leaseId, tx.hash, err);
      }
      if (err instanceof QuotaExceededError) {
        return refuseQuota(apiKey, lease, tx.hash, err);
      }
      throw err;
    }
    recordAudit(db, {
      apiKeyId: apiKey.id,
      action: 'witness',
      outcome: 'issued',
      detail: { leaseId, txHash: tx.hash, kind: verdict.kind ?? null, sponsoredLovelace, fee: tx.fee.toString() },
    });
    logger?.info({ leaseId, txHash: tx.hash, kind: verdict.kind, sponsoredLovelace }, 'Witness issued');
    return { leaseId, witnessSet };
  };

  return { issue };
};
