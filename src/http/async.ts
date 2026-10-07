import type { NextFunction, Request, RequestHandler, Response } from 'express';

/**
 * Wraps a handler that returns a promise so a rejection reaches the error
 * middleware instead of hanging the request, which express 4 does not do
 * on its own.
 */
export const asyncHandler =
  (handler: (req: Request, res: Response) => Promise<void>): RequestHandler =>
  (req: Request, res: Response, next: NextFunction): void => {
    handler(req, res).catch(next);
  };
