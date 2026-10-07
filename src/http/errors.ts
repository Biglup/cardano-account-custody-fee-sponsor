import type { NextFunction, Request, Response } from 'express';

/** The JSON body every error response carries: a machine readable code, and, for a policy failure, which rule failed and why. */
export interface ErrorResponseBody {
  error: string;
  rule?: string;
  detail?: string;
}

/**
 * The base of every error the service maps to a specific HTTP status and
 * JSON body. Application code throws a subclass; the error middleware is
 * the only place that turns one into a response.
 */
export class ServiceError extends Error {
  readonly status: number;
  readonly code: string;
  readonly detail: string | undefined;
  readonly rule: string | undefined;

  constructor(status: number, code: string, detail?: string, rule?: string) {
    super(detail ?? code);
    this.name = new.target.name;
    this.status = status;
    this.code = code;
    this.detail = detail;
    this.rule = rule;
  }

  /** The JSON body to send for this error, with no field set to an empty value. */
  toResponseBody(): ErrorResponseBody {
    const body: ErrorResponseBody = { error: this.code };
    if (this.rule !== undefined) {
      body.rule = this.rule;
    }
    if (this.detail !== undefined) {
      body.detail = this.detail;
    }
    return body;
  }
}

/** The caller did not present a valid API key. */
export class UnauthorizedError extends ServiceError {
  constructor(detail = 'A valid API key is required') {
    super(401, 'unauthorized', detail);
  }
}

/** No route matches the request. */
export class NotFoundError extends ServiceError {
  constructor(detail = 'No such route') {
    super(404, 'not_found', detail);
  }
}

/** The lease id in the request does not exist. */
export class UnknownLeaseError extends ServiceError {
  constructor(leaseId: string) {
    super(404, 'unknown_lease', `No lease ${leaseId} exists`);
  }
}

/** The lease's TTL has passed, or the client gave it up early; nothing can be built on it any more. */
export class LeaseExpiredError extends ServiceError {
  constructor(leaseId: string, detail = `Lease ${leaseId} has expired`) {
    super(410, 'lease_expired', detail);
  }
}

/** The client gave the lease up early; it answers as expired, since nothing can be built on it either. */
export class LeaseReleasedError extends LeaseExpiredError {
  constructor(leaseId: string) {
    super(leaseId, `Lease ${leaseId} was released`);
  }
}

/** The lease already issued its one witness. */
export class LeaseConsumedError extends ServiceError {
  constructor(leaseId: string) {
    super(409, 'lease_consumed', `Lease ${leaseId} already issued a witness`);
  }
}

/** Every fee UTxO in the pool is currently leased. */
export class NoUtxoAvailableError extends ServiceError {
  constructor(detail = 'Every fee UTxO is leased') {
    super(409, 'no_utxo_available', detail);
  }
}

/** The pool is empty and the sponsor wallet cannot be split further. */
export class OutOfFundsError extends ServiceError {
  constructor(detail = 'The sponsor pool is empty and cannot be split further') {
    super(503, 'out_of_funds', detail);
  }
}

/** A submitted transaction failed a transaction policy rule. */
export class InvalidTransactionError extends ServiceError {
  constructor(rule: string, detail: string) {
    super(422, 'invalid_transaction', detail, rule);
  }
}

/** The request body or parameters do not match what the endpoint expects. */
export class ValidationError extends ServiceError {
  constructor(detail: string) {
    super(400, 'invalid_request', detail);
  }
}

/** The caller exceeded a rate limit. */
export class RateLimitedError extends ServiceError {
  constructor(detail = 'Too many requests') {
    super(429, 'rate_limited', detail);
  }
}

/** The caller's API key reached one of its quotas; the detail names the quota first. */
export class QuotaExceededError extends ServiceError {
  constructor(quota: string, detail: string) {
    super(429, 'quota_exceeded', `${quota}: ${detail}`);
  }
}

/**
 * Routes a request that matched nothing to the error middleware as a
 * `NotFoundError`, so unmatched routes get the same JSON shape as every
 * other failure.
 */
export const notFoundHandler = (req: Request, _res: Response, next: NextFunction): void => {
  next(new NotFoundError(`No route for ${req.method} ${req.path}`));
};

/** Whether `err` carries an HTTP status in the 4xx range, the shape body-parser uses for a malformed or oversized request. */
const isClientHttpError = (err: unknown): err is { status: number } =>
  typeof err === 'object' &&
  err !== null &&
  'status' in err &&
  typeof (err as { status: unknown }).status === 'number' &&
  (err as { status: number }).status >= 400 &&
  (err as { status: number }).status < 500;

/**
 * The single place a failure becomes an HTTP response. A `ServiceError`
 * is reported with its own status and body. A client error raised by
 * middleware ahead of the router, such as body-parser, is reported with
 * its own status and a code for that status: `payload_too_large` for a
 * body over the size limit, `invalid_request` for any other 4xx. Anything
 * else is logged and answered with a generic 500, since an error that
 * was not anticipated may carry a stack trace or request data that must
 * never reach a client.
 */
export const errorHandler = (err: unknown, req: Request, res: Response, _next: NextFunction): void => {
  if (err instanceof ServiceError) {
    res.status(err.status).json(err.toResponseBody());
    return;
  }
  if (isClientHttpError(err)) {
    const code = err.status === 413 ? 'payload_too_large' : 'invalid_request';
    res.status(err.status).json({ error: code });
    return;
  }
  req.log.error({ err }, 'Unhandled error');
  res.status(500).json({ error: 'internal_error' });
};
