/**
 * The bodies the API exchanges with a client, which the routes produce
 * and the client adapter consumes. This module imports nothing, so that
 * the adapter's declarations, which a consumer type checks against,
 * reach no server module and need none of the server's dependencies.
 */

/** A sponsor UTxO as the API presents it, with the address the client must resolve it at. */
export interface SponsorUtxoBody {
  txHash: string;
  index: number;
  address: string;
  lovelace: number;
}

/** The body of a lease response: the leased fee UTxO, the shared collateral UTxO as of the answer, and the sponsor's terms. */
export interface LeaseBody {
  leaseId: string;
  expiresAt: string;
  fee: SponsorUtxoBody;
  collateral: SponsorUtxoBody;
  sponsorAddress: string;
  maxSponsoredLovelace: number;
}

/**
 * The body of a collateral response: the shared collateral UTxO, the
 * sponsor address its return must pay, and how many seconds from now the
 * validity upper bound of a transaction witnessed in collateral mode may
 * reach at most.
 */
export interface CollateralBody extends SponsorUtxoBody {
  sponsorAddress: string;
  validitySeconds: number;
}

/** The body of a witness response: the sponsor's witness set as CBOR hex and the lease it consumed. */
export interface WitnessBody {
  witnessSet: string;
  leaseId: string;
}

/** The body of a collateral witness response: the sponsor's witness set as CBOR hex and the hash of the transaction it signs. */
export interface CollateralWitnessBody {
  witnessSet: string;
  txHash: string;
}

/** The JSON body every error response carries: a machine readable code, and, for a policy failure, which rule failed and why. */
export interface ErrorResponseBody {
  error: string;
  rule?: string;
  detail?: string;
}
