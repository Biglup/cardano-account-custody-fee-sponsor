import { z } from 'zod';
import { ValidationError } from './errors.js';

/** The body of a witness request: the unsigned transaction as CBOR hex; whether it decodes is the policy's first rule. */
export const witnessSchema = z.object({ transaction: z.string().min(1) }).strict();

/** Parses a request body, or its query, against `schema`, reporting the first issue as a validation error. */
export const parseBody = <T>(schema: z.ZodType<T>, body: unknown): T => {
  const result = schema.safeParse(body ?? {});
  if (!result.success) {
    const issue = result.error.issues[0];
    throw new ValidationError(`${issue?.path.join('.') || 'body'}: ${issue?.message ?? 'invalid'}`);
  }
  return result.data;
};
