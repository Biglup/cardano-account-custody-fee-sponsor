import { describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';
import {
  InvalidTransactionError,
  LeaseConsumedError,
  NoUtxoAvailableError,
  type ServiceError,
  UnknownLeaseError,
  errorHandler,
} from '../../src/http/errors.js';

const mockResponse = (): Response => {
  const res = {} as Response;
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  return res;
};

const mockRequest = (): Request => ({ log: { error: vi.fn() } }) as unknown as Request;

describe('errorHandler', () => {
  it('maps a ServiceError to its documented status and JSON body', () => {
    const res = mockResponse();
    errorHandler(new UnknownLeaseError('lease-1'), mockRequest(), res, vi.fn());

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith({ error: 'unknown_lease', detail: 'No lease lease-1 exists' });
  });

  it('includes the rule name for an invalid transaction', () => {
    const res = mockResponse();
    errorHandler(new InvalidTransactionError('uses_leased_fee_input', 'The transaction spends a UTxO that is not leased'), mockRequest(), res, vi.fn());

    expect(res.status).toHaveBeenCalledWith(422);
    expect(res.json).toHaveBeenCalledWith({
      error: 'invalid_transaction',
      rule: 'uses_leased_fee_input',
      detail: 'The transaction spends a UTxO that is not leased',
    });
  });

  it('maps every documented error code to its status', () => {
    const cases: [ServiceError, number][] = [
      [new LeaseConsumedError('lease-2'), 409],
      [new NoUtxoAvailableError(), 409],
    ];
    for (const [err, status] of cases) {
      const res = mockResponse();
      errorHandler(err, mockRequest(), res, vi.fn());
      expect(res.status).toHaveBeenCalledWith(status);
    }
  });

  it('maps a body-parser 413 to payload_too_large', () => {
    const res = mockResponse();
    errorHandler({ status: 413 }, mockRequest(), res, vi.fn());

    expect(res.status).toHaveBeenCalledWith(413);
    expect(res.json).toHaveBeenCalledWith({ error: 'payload_too_large' });
  });

  it('maps any other body-parser 4xx to invalid_request', () => {
    const res = mockResponse();
    errorHandler({ status: 400 }, mockRequest(), res, vi.fn());

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ error: 'invalid_request' });
  });

  it('never leaks a stack trace or the request body for an unexpected error', () => {
    const res = mockResponse();
    const req = mockRequest();
    errorHandler(new Error('something internal broke with a stack'), req, res, vi.fn());

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ error: 'internal_error' });
    expect(req.log.error).toHaveBeenCalled();
  });
});
