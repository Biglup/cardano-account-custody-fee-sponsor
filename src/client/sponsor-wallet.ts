import type {
  Address,
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
import type { ErrorResponseBody, LeaseBody, LeasedUtxoBody, WitnessBody } from '../api.js';
import { Cometa } from '../cometa.js';
import { transactionHash } from '../transaction-hash.js';

/** What a sponsor wallet needs to reach the service and the chain. */
export interface SponsorWalletOptions {
  /** Where the service listens, such as `https://sponsor.example`; the API paths are appended to it. */
  baseUrl: string;
  /** The client key the service issued. */
  apiKey: string;
  /** The provider the wallet reads protocol parameters from, evaluates with and submits through. */
  provider: Provider;
  /** The fetch the service is called with; the global one unless given, which tests replace with one reaching an in process application. */
  fetch?: typeof fetch;
  /** The clock the lease expiry is measured against; the system clock unless given. */
  now?: () => Date;
}

/** The error codes after which the lease the wallet holds can no longer be built on, so the next use takes a new one. */
const LEASE_GONE = new Set(['unknown_lease', 'lease_expired', 'lease_consumed']);

/** The lease a witness consumed and the transaction it was issued for, which a repeat of that transaction is routed back to. */
interface ConsumedLease {
  leaseId: string;
  txHash: string;
}

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

/** The UTxO a leased UTxO of the API response resolves to. */
const leasedUtxo = (utxo: LeasedUtxoBody): UTxO => ({
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
 * the account contract's builders. It holds one lease at a time, taken
 * on first use and kept until a witness consumes it, `release` gives it
 * up or it expires, after which the next use takes a new one. What it
 * reports as its own is what the lease grants: the sponsor address, the
 * leased fee UTxO as its only spendable output and the leased collateral
 * UTxO as its only collateral. Its builders expire with the lease, so a
 * transaction built on them passes the service's validity bound
 * unchanged. Signing posts the transaction to the service and returns
 * the sponsor's witness set, which the client merges with its own
 * signatures before submitting; the sponsor never submits on the
 * client's behalf, so submitting goes straight to the provider. Signing
 * the same transaction again, as a client does after losing the answer,
 * goes back to the lease that transaction consumed, where the service
 * reissues the same witness set. A refusal by the service is thrown as
 * a `SponsorError`.
 */
export class SponsorWallet implements Wallet {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly provider: Provider;
  private readonly fetch: typeof fetch;
  private readonly now: () => Date;
  private held: LeaseBody | undefined;
  private pending: Promise<LeaseBody> | undefined;
  private consumed: ConsumedLease | undefined;

  constructor({ baseUrl, apiKey, provider, fetch: fetchFn = globalThis.fetch, now = () => new Date() }: SponsorWalletOptions) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.apiKey = apiKey;
    this.provider = provider;
    this.fetch = fetchFn;
    this.now = now;
  }

  /** The lease the wallet currently holds, or undefined when the next use will take one. */
  get lease(): LeaseBody | undefined {
    return this.held !== undefined && !this.isExpired(this.held) ? this.held : undefined;
  }

  /** Gives the held lease back to the pool, if it holds one that is still open; nothing happens otherwise. */
  async release(): Promise<void> {
    const lease = this.lease;
    this.held = undefined;
    if (lease === undefined) {
      return;
    }
    const response = await this.call('DELETE', `/v1/leases/${lease.leaseId}`);
    if (!response.ok) {
      throw await this.errorOf(response);
    }
  }

  /** The sponsor address, which the lease names. */
  async getAddress(): Promise<Address> {
    return Cometa.Address.fromString((await this.currentLease()).sponsorAddress);
  }

  async getNetworkId(): Promise<NetworkId> {
    return this.provider.getNetworkMagic() === Cometa.NetworkMagic.Mainnet ? Cometa.NetworkId.Mainnet : Cometa.NetworkId.Testnet;
  }

  /** The leased fee UTxO, the only sponsor UTxO a transaction may spend. */
  async getUnspentOutputs(): Promise<UTxO[]> {
    return [leasedUtxo((await this.currentLease()).fee)];
  }

  async getBalance(): Promise<Value> {
    return { coins: BigInt((await this.currentLease()).fee.lovelace) };
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
   * signatures itself. The lease is consumed by a witness; a refusal
   * under the policy leaves it open for a corrected transaction, while a
   * lease the service reports as gone is dropped so the next use takes a
   * new one. The transaction the last witness was issued for is asked
   * again on the lease it consumed rather than on a new one, so that a
   * client that lost the answer gets the same witness set back and takes
   * no second lease for it.
   */
  async signTransaction(txCbor: string, _partialSign: boolean): Promise<VkeyWitnessSet> {
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
    const body = (await response.json()) as WitnessBody;
    return Cometa.readVkeyWitnessSetFromWitnessSetCbor(body.witnessSet);
  }

  signData(): Promise<{ signature: string; key: string }> {
    return Promise.reject(new Error('The sponsor signs transactions only'));
  }

  submitTransaction(txCbor: string): Promise<string> {
    return this.provider.submitTransaction(txCbor);
  }

  /** The leased collateral UTxO, the only collateral a transaction may declare. */
  async getCollateral(): Promise<UTxO[]> {
    return [leasedUtxo((await this.currentLease()).collateral)];
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
   * A builder set up the way the service expects a sponsored transaction:
   * the leased fee UTxO as the only spendable UTxO, the leased collateral
   * UTxO as the only collateral, both change outputs to the sponsor
   * address, the provider as the evaluator, and the validity upper bound
   * at the lease expiry. The protocol parameters are read from the
   * provider for every builder, so a wallet that lives across a parameter
   * change builds with the current fee and deposit values.
   */
  async createTransactionBuilder(): Promise<TransactionBuilder> {
    const lease = await this.currentLease();
    const params = await this.provider.getParameters();
    return Cometa.TransactionBuilder.create({ params, slotConfig: slotConfigOf(this.provider.getNetworkMagic()) })
      .setTxEvaluator({ getName: () => 'Sponsor provider evaluator', evaluate: (tx, additional) => this.provider.evaluateTransaction(tx, additional) })
      .setChangeAddress(lease.sponsorAddress)
      .setCollateralChangeAddress(lease.sponsorAddress)
      .setUtxos([leasedUtxo(lease.fee)])
      .setCollateralUtxos([leasedUtxo(lease.collateral)])
      .expiresAfter(new Date(lease.expiresAt));
  }

  /** Whether the lease's expiry has passed on the wallet's clock. */
  private isExpired(lease: LeaseBody): boolean {
    return new Date(lease.expiresAt).getTime() <= this.now().getTime();
  }

  /**
   * The lease the wallet holds, taking one when it holds none or the one
   * it held has expired. Uses that start while a lease is being taken
   * wait for that one rather than taking their own, so that a wallet
   * asked several things at once on first use holds one lease and not
   * one per question.
   */
  private currentLease(): Promise<LeaseBody> {
    const lease = this.lease;
    if (lease !== undefined) {
      return Promise.resolve(lease);
    }
    this.pending ??= this.takeLease().finally(() => {
      this.pending = undefined;
    });
    return this.pending;
  }

  /** Takes a new lease from the service and holds it. */
  private async takeLease(): Promise<LeaseBody> {
    const response = await this.call('POST', '/v1/leases');
    if (!response.ok) {
      throw await this.errorOf(response);
    }
    this.held = (await response.json()) as LeaseBody;
    return this.held;
  }

  /** Calls the service with the client key, sending `body` as JSON when given. */
  private call(method: 'POST' | 'DELETE', path: string, body?: unknown): Promise<Response> {
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
