import type {
  Address,
  CoinSelector,
  NetworkId,
  Provider,
  RewardAddress,
  SlotConfig,
  TransactionBuilder,
  UTxO,
  Value,
  VkeyWitnessSet,
  Wallet,
} from '@biglup/cometa';
import type { CollateralBody, CollateralWitnessBody, ErrorResponseBody, LeaseBody, SponsorUtxoBody, WitnessBody } from '../api.js';
import { Cometa } from '../cometa.js';
import { transactionHash } from '../transaction-hash.js';

/**
 * How the sponsor takes part in the transactions a wallet builds: `fee`
 * leases a fee UTxO the sponsor pays from, `collateral` contributes the
 * shared collateral alone to a transaction that pays its own fee, as an
 * owner operation paid from the account does.
 */
export type SponsorWalletMode = 'fee' | 'collateral';

/** What a sponsor wallet needs to reach the service and the chain. */
export interface SponsorWalletOptions {
  /** Where the service listens, such as `https://sponsor.example`; the API paths are appended to it. */
  baseUrl: string;
  /** The client key the service issued. */
  apiKey: string;
  /** The provider the wallet reads protocol parameters from, evaluates with and submits through. */
  provider: Provider;
  /** Whether the sponsor pays the fee from a leased UTxO, which is the default, or contributes collateral alone. */
  mode?: SponsorWalletMode;
  /** The fetch the service is called with; the global one unless given, which tests replace with one reaching an in process application. */
  fetch?: typeof fetch;
  /** The clock the lease expiry and the collateral validity bound are measured against; the system clock unless given. */
  now?: () => Date;
}

/** The error codes after which the lease the wallet holds can no longer be built on, so the next use takes a new one. */
const LEASE_GONE = new Set(['unknown_lease', 'lease_expired', 'lease_consumed']);

/** The policy rule whose refusal says the shared collateral the wallet holds was replaced, so the next use reads it again. */
const COLLATERAL_REPLACED = 'uses_shared_collateral';

/**
 * How much of the collateral validity window a builder leaves unused when
 * it presets the validity upper bound, so that a clock a little ahead of
 * the service's, and the time spent building and signing, keep the bound
 * within the window the service measures from its own now.
 */
const COLLATERAL_BOUND_MARGIN_SECONDS = 60;

/**
 * A coin selector that spends nothing beyond the inputs the builder was
 * given explicitly, for collateral mode, where the sponsor offers no
 * UTxO to draw on and the inputs the client adds must cover the
 * transaction, as the account's fund UTxOs do.
 */
const explicitInputsOnly: CoinSelector = {
  getName: () => 'Explicit inputs only',
  select: ({ preSelectedUtxo, availableUtxo }) => Promise.resolve({ selection: preSelectedUtxo ?? [], remaining: availableUtxo }),
};

/** The lease a witness consumed and the transaction it was issued for, which a repeat of that transaction is routed back to. */
interface ConsumedLease {
  leaseId: string;
  txHash: string;
}

/** What the service granted the wallet to build on: a lease in fee mode, the shared collateral in collateral mode. */
type Grant = { mode: 'fee'; lease: LeaseBody } | { mode: 'collateral'; collateral: CollateralBody };

/** The error code of an answer that carries no error body the service would send, such as a proxy's. */
const UNEXPECTED_RESPONSE = 'unexpected_response';

/**
 * A refusal by the service, as the wallet surfaces it: the HTTP status,
 * the service's error code, the policy rule that failed when the code is
 * `invalid_transaction`, and the detail sentence.
 */
export class SponsorError extends Error {
  readonly status: number;
  readonly code: string;
  readonly rule: string | undefined;
  readonly detail: string;

  constructor(status: number, code: string, detail: string, rule?: string) {
    super(rule === undefined ? `${code}: ${detail}` : `${code} (${rule}): ${detail}`);
    this.name = 'SponsorError';
    this.status = status;
    this.code = code;
    this.rule = rule;
    this.detail = detail;
  }
}

/** The UTxO a sponsor UTxO of the API response resolves to. */
const sponsorUtxo = (utxo: SponsorUtxoBody): UTxO => ({
  input: { txId: utxo.txHash, index: utxo.index },
  output: { address: utxo.address, value: { coins: BigInt(utxo.lovelace) } },
});

/** The hash of a transaction, or undefined when it does not decode, which the service then refuses as not well formed. */
const hashOf = (txCbor: string): string | undefined => {
  try {
    return transactionHash(txCbor);
  } catch {
    return undefined;
  }
};

/** The slot timing of the network a provider serves. */
const slotConfigOf = (networkMagic: number): SlotConfig => {
  switch (networkMagic) {
    case Cometa.NetworkMagic.Mainnet:
      return Cometa.CARDANO_MAINNET_SLOT_CONFIG;
    case Cometa.NetworkMagic.Preprod:
      return Cometa.CARDANO_PREPROD_SLOT_CONFIG;
    case Cometa.NetworkMagic.Preview:
      return Cometa.CARDANO_PREVIEW_SLOT_CONFIG;
    default:
      throw new Error(`Unsupported network magic: ${networkMagic}`);
  }
};

/**
 * A cometa wallet over the sponsor service, to pass as the `sponsor` of
 * the account contract's builders. In fee mode it holds one lease at a
 * time, taken on first use and kept until a witness consumes it,
 * `release` gives it up or it expires, after which the next use takes a
 * new one; what it reports as its own is what the lease grants: the
 * sponsor address, the leased fee UTxO as its only spendable output and
 * the shared collateral UTxO as its only collateral. Its builders expire
 * with the lease, so a transaction built on them passes the service's
 * validity bound unchanged. In collateral mode it holds no lease: it
 * reads the shared collateral UTxO on first use, reports no spendable
 * output at all, since the transaction pays its own fee, and its builders
 * expire within the collateral validity window. Signing posts the
 * transaction to the service's witness route for the mode and returns
 * the sponsor's witness set, which the client merges with its own
 * signatures before submitting; the sponsor never submits on the
 * client's behalf, so submitting goes straight to the provider. Signing
 * the same transaction again, as a client does after losing the answer,
 * receives the same witness set: in fee mode by going back to the lease
 * that transaction consumed, in collateral mode because the service keys
 * its witnesses by transaction. A refusal by the service is thrown as a
 * `SponsorError`.
 */
export class SponsorWallet implements Wallet {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly provider: Provider;
  private readonly mode: SponsorWalletMode;
  private readonly fetch: typeof fetch;
  private readonly now: () => Date;
  private held: Grant | undefined;
  private pending: Promise<Grant> | undefined;
  private consumed: ConsumedLease | undefined;

  constructor({ baseUrl, apiKey, provider, mode = 'fee', fetch: fetchFn = globalThis.fetch, now = () => new Date() }: SponsorWalletOptions) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.apiKey = apiKey;
    this.provider = provider;
    this.mode = mode;
    this.fetch = fetchFn;
    this.now = now;
  }

  /** The lease the wallet currently holds, or undefined when the next use will take one, or in collateral mode. */
  get lease(): LeaseBody | undefined {
    const grant = this.grant;
    return grant?.mode === 'fee' ? grant.lease : undefined;
  }

  /** The shared collateral the wallet currently holds, or undefined when the next use will read it, or in fee mode. */
  get collateral(): CollateralBody | undefined {
    const grant = this.grant;
    return grant?.mode === 'collateral' ? grant.collateral : undefined;
  }

  /**
   * Holds nothing afterwards, whatever the state: a request for a grant
   * still in flight is waited for and what it yields is given up too, a
   * lease still open is given back to the pool, and the shared collateral
   * is simply forgotten, since nothing holds it.
   */
  async release(): Promise<void> {
    if (this.pending !== undefined) {
      await this.pending.catch(() => undefined);
    }
    const grant = this.grant;
    this.held = undefined;
    if (grant?.mode !== 'fee') {
      return;
    }
    const response = await this.call('DELETE', `/v1/leases/${grant.lease.leaseId}`);
    if (!response.ok) {
      throw await this.errorOf(response);
    }
  }

  /** The sponsor address, which the grant names. */
  async getAddress(): Promise<Address> {
    return Cometa.Address.fromString(this.sponsorAddressOf(await this.currentGrant()));
  }

  async getNetworkId(): Promise<NetworkId> {
    return this.provider.getNetworkMagic() === Cometa.NetworkMagic.Mainnet ? Cometa.NetworkId.Mainnet : Cometa.NetworkId.Testnet;
  }

  /** The leased fee UTxO, the only sponsor UTxO a transaction may spend; nothing in collateral mode. */
  async getUnspentOutputs(): Promise<UTxO[]> {
    const grant = await this.currentGrant();
    return grant.mode === 'fee' ? [sponsorUtxo(grant.lease.fee)] : [];
  }

  async getBalance(): Promise<Value> {
    const grant = await this.currentGrant();
    return { coins: grant.mode === 'fee' ? BigInt(grant.lease.fee.lovelace) : 0n };
  }

  async getUsedAddresses(): Promise<Address[]> {
    return [await this.getAddress()];
  }

  getUnusedAddresses(): Promise<Address[]> {
    return Promise.resolve([]);
  }

  getChangeAddress(): Promise<Address> {
    return this.getAddress();
  }

  /** None: the service never lets a transaction touch the sponsor's reward account. */
  getRewardAddresses(): Promise<RewardAddress[]> {
    return Promise.resolve([]);
  }

  /**
   * Asks the service for the sponsor's witness set over the transaction.
   * The service signs with its payment key alone whatever is asked, so
   * `partialSign` makes no difference; the client adds the other
   * signatures itself. In fee mode the lease is consumed by a witness; a
   * refusal under the policy leaves it open for a corrected transaction,
   * while a lease the service reports as gone is dropped so the next use
   * takes a new one, and the transaction the last witness was issued for
   * is asked again on the lease it consumed rather than on a new one, so
   * that a client that lost the answer gets the same witness set back and
   * takes no second lease for it. In collateral mode the service answers
   * the same transaction with the same witness set by itself; a refusal
   * saying the shared collateral is no longer the one held drops it, so
   * the next builder reads the current one.
   */
  async signTransaction(txCbor: string, _partialSign: boolean): Promise<VkeyWitnessSet> {
    const body = this.mode === 'fee' ? await this.witnessOnLease(txCbor) : await this.witnessOnCollateral(txCbor);
    return Cometa.readVkeyWitnessSetFromWitnessSetCbor(body.witnessSet);
  }

  signData(): Promise<{ signature: string; key: string }> {
    return Promise.reject(new Error('The sponsor signs transactions only'));
  }

  submitTransaction(txCbor: string): Promise<string> {
    return this.provider.submitTransaction(txCbor);
  }

  /** The shared collateral UTxO, the only collateral a transaction may declare. */
  async getCollateral(): Promise<UTxO[]> {
    const grant = await this.currentGrant();
    return [sponsorUtxo(grant.mode === 'fee' ? grant.lease.collateral : grant.collateral)];
  }

  getNetworkMagic(): Promise<number> {
    return Promise.resolve(this.provider.getNetworkMagic());
  }

  getPubDRepKey(): Promise<string> {
    return Promise.reject(new Error('The sponsor has no DRep key'));
  }

  getRegisteredPubStakeKeys(): Promise<string[]> {
    return Promise.resolve([]);
  }

  getUnregisteredPubStakeKeys(): Promise<string[]> {
    return Promise.resolve([]);
  }

  /**
   * A builder set up the way the service expects a transaction of the
   * mode. In fee mode: the leased fee UTxO as the only spendable UTxO,
   * the shared collateral UTxO as the only collateral, both change
   * outputs to the sponsor address, the provider as the evaluator, and
   * the validity upper bound at the lease expiry. In collateral mode: no
   * spendable UTxO and a coin selector that adds none, since the
   * transaction pays its own fee from inputs the client adds, the shared
   * collateral UTxO as the only collateral with its return to the sponsor
   * address, the provider as the evaluator, and the validity upper bound
   * at now plus the collateral validity window less a margin; the change
   * address is the client's to set, since change to the sponsor is
   * refused in that mode. The
   * protocol parameters are read from the provider for every builder, so
   * a wallet that lives across a parameter change builds with the current
   * fee and deposit values.
   */
  async createTransactionBuilder(): Promise<TransactionBuilder> {
    const grant = await this.currentGrant();
    const params = await this.provider.getParameters();
    const builder = Cometa.TransactionBuilder.create({ params, slotConfig: slotConfigOf(this.provider.getNetworkMagic()) })
      .setTxEvaluator({ getName: () => 'Sponsor provider evaluator', evaluate: (tx, additional) => this.provider.evaluateTransaction(tx, additional) })
      .setCollateralChangeAddress(this.sponsorAddressOf(grant));
    if (grant.mode === 'fee') {
      return builder
        .setChangeAddress(grant.lease.sponsorAddress)
        .setUtxos([sponsorUtxo(grant.lease.fee)])
        .setCollateralUtxos([sponsorUtxo(grant.lease.collateral)])
        .expiresAfter(new Date(grant.lease.expiresAt));
    }
    const margin = Math.min(COLLATERAL_BOUND_MARGIN_SECONDS, Math.floor(grant.collateral.validitySeconds / 2));
    return builder
      .setUtxos([])
      .setCoinSelector(explicitInputsOnly)
      .setCollateralUtxos([sponsorUtxo(grant.collateral)])
      .expiresAfter(new Date(this.now().getTime() + (grant.collateral.validitySeconds - margin) * 1000));
  }

  /** The grant the wallet holds, or undefined when it holds none or holds a lease that has expired on the wallet's clock. */
  private get grant(): Grant | undefined {
    const grant = this.held;
    if (grant?.mode === 'fee' && new Date(grant.lease.expiresAt).getTime() <= this.now().getTime()) {
      return undefined;
    }
    return grant;
  }

  /** The sponsor address a grant names. */
  private sponsorAddressOf(grant: Grant): string {
    return grant.mode === 'fee' ? grant.lease.sponsorAddress : grant.collateral.sponsorAddress;
  }

  /**
   * The grant the wallet holds, taking one when it holds none or the
   * lease it held has expired. Calls that start while a grant is being
   * taken wait for that one rather than taking their own, so that a
   * wallet asked several things at once on first use holds one lease and
   * not one per question.
   */
  private currentGrant(): Promise<Grant> {
    const grant = this.grant;
    if (grant !== undefined) {
      return Promise.resolve(grant);
    }
    this.pending ??= this.takeGrant().finally(() => {
      this.pending = undefined;
    });
    return this.pending;
  }

  /** Takes a new lease, or reads the shared collateral, from the service and holds it. */
  private async takeGrant(): Promise<Grant> {
    const response = this.mode === 'fee' ? await this.call('POST', '/v1/leases') : await this.call('GET', '/v1/collateral');
    if (!response.ok) {
      throw await this.errorOf(response);
    }
    const grant: Grant =
      this.mode === 'fee'
        ? { mode: 'fee', lease: (await response.json()) as LeaseBody }
        : { mode: 'collateral', collateral: (await response.json()) as CollateralBody };
    this.held = grant;
    return grant;
  }

  /** The lease the wallet holds in fee mode, taking one when it holds none. */
  private async currentLease(): Promise<LeaseBody> {
    const grant = await this.currentGrant();
    if (grant.mode !== 'fee') {
      throw new Error('The sponsor wallet holds no lease in collateral mode');
    }
    return grant.lease;
  }

  /** The witness set the lease route answers for the transaction, on the lease held or the one the same transaction consumed. */
  private async witnessOnLease(txCbor: string): Promise<WitnessBody> {
    const txHash = hashOf(txCbor);
    const repeat = txHash !== undefined && this.consumed?.txHash === txHash ? this.consumed : undefined;
    const leaseId = repeat?.leaseId ?? (await this.currentLease()).leaseId;
    const response = await this.call('POST', `/v1/leases/${leaseId}/witness`, { transaction: txCbor });
    if (!response.ok) {
      const error = await this.errorOf(response);
      if (LEASE_GONE.has(error.code)) {
        if (repeat === undefined) {
          this.held = undefined;
        } else {
          this.consumed = undefined;
        }
      }
      throw error;
    }
    if (repeat === undefined) {
      this.held = undefined;
      this.consumed = txHash === undefined ? undefined : { leaseId, txHash };
    }
    return (await response.json()) as WitnessBody;
  }

  /** The witness set the collateral route answers for the transaction. */
  private async witnessOnCollateral(txCbor: string): Promise<CollateralWitnessBody> {
    const response = await this.call('POST', '/v1/collateral/witness', { transaction: txCbor });
    if (!response.ok) {
      const error = await this.errorOf(response);
      if (error.rule === COLLATERAL_REPLACED) {
        this.held = undefined;
      }
      throw error;
    }
    return (await response.json()) as CollateralWitnessBody;
  }

  /** Calls the service with the client key, sending `body` as JSON when given. */
  private call(method: 'GET' | 'POST' | 'DELETE', path: string, body?: unknown): Promise<Response> {
    const headers: Record<string, string> = { authorization: `Bearer ${this.apiKey}` };
    if (body === undefined) {
      return this.fetch(`${this.baseUrl}${path}`, { method, headers });
    }
    headers['content-type'] = 'application/json';
    return this.fetch(`${this.baseUrl}${path}`, { method, headers, body: JSON.stringify(body) });
  }

  /** The error a failed response describes, or one saying the answer was not the service's when the body is no error body. */
  private async errorOf(response: Response): Promise<SponsorError> {
    let body: ErrorResponseBody | undefined;
    try {
      body = (await response.json()) as ErrorResponseBody;
    } catch {
      body = undefined;
    }
    if (body === undefined || typeof body.error !== 'string') {
      return new SponsorError(response.status, UNEXPECTED_RESPONSE, `The sponsor service answered with status ${response.status}`);
    }
    return new SponsorError(response.status, body.error, body.detail ?? body.error, body.rule);
  }
}
