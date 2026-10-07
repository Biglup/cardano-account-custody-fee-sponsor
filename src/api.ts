/**
 * The bodies the API exchanges with a client, which the routes produce
 * and the client adapter consumes. This module imports nothing, so that
 * the adapter's declarations, which a consumer type checks against,
 * reach no server module and need none of the server's dependencies.
 */

/** A leased UTxO as the API presents it, with the address the client must resolve it at. */
export interface LeasedUtxoBody {
  txHash: string;
  index: number;
  address: string;
  lovelace: number;
}

/** The body of a lease response. */
export interface LeaseBody {
  leaseId: string;
  expiresAt: string;
  fee: LeasedUtxoBody;
  collateral: LeasedUtxoBody;
  sponsorAddress: string;
  maxSponsoredLovelace: number;
}

/** The body of a witness response: the sponsor's witness set as CBOR hex and the lease it consumed. */
export interface WitnessBody {
  witnessSet: string;
  leaseId: string;
}

/** The JSON body every error response carries: a machine readable code, and, for a policy failure, which rule failed and why. */
export interface ErrorResponseBody {
  error: string;
  rule?: string;
  detail?: string;
}
