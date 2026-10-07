import pino, { type DestinationStream, type Logger } from 'pino';

/**
 * The log fields that can never be allowed through: the bearer key in a
 * request's authorization header, and any field named after a secret
 * (a mnemonic, a key, an API key), at the top of a log entry or one
 * level down, which is where a serialised config or request body would
 * carry it.
 */
const REDACTED_PATHS = [
  'req.headers.authorization',
  'mnemonic',
  '*.mnemonic',
  'sponsorMnemonic',
  '*.sponsorMnemonic',
  'key',
  '*.key',
  'apiKey',
  '*.apiKey',
  'adminApiKey',
  '*.adminApiKey',
];

/** What a redacted field shows in a log line instead of its value. */
export const REDACTED = '[redacted]';

/**
 * The logger every part of the service uses. Redaction runs before a line
 * is written, so a secret that reaches a log call still never reaches a
 * log line. The destination defaults to standard output; tests pass a
 * stream of their own to read the lines back.
 */
export const createLogger = (destination?: DestinationStream): Logger =>
  pino({ redact: { paths: REDACTED_PATHS, censor: REDACTED } }, destination);
