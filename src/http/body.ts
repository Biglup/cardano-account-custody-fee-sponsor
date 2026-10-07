import type { z } from 'zod';
import { ValidationError } from './errors.js';

/** Parses a request body against `schema`, reporting the first issue as a validation error. */
export const parseBody = <T>(schema: z.ZodType<T>, body: unknown): T => {
  const result = schema.safeParse(body ?? {});
  if (!result.success) {
    const issue = result.error.issues[0];
    throw new ValidationError(`${issue?.path.join('.') || 'body'}: ${issue?.message ?? 'invalid'}`);
  }
  return result.data;
};
