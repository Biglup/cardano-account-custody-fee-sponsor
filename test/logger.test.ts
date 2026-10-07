import { describe, expect, it } from 'vitest';
import { REDACTED, createLogger } from '../src/logger.js';

/** A logger writing into `lines`, each parsed back from its JSON. */
const capturingLogger = (): { lines: Record<string, unknown>[]; log: ReturnType<typeof createLogger> } => {
  const lines: Record<string, unknown>[] = [];
  const log = createLogger({ write: (line: string) => lines.push(JSON.parse(line) as Record<string, unknown>) });
  return { lines, log };
};

describe('createLogger', () => {
  it('redacts the authorization header of a logged request', () => {
    const { lines, log } = capturingLogger();

    log.info({ req: { method: 'POST', headers: { authorization: 'Bearer secret-key', accept: 'application/json' } } }, 'request');

    expect(lines[0]?.req).toEqual({ method: 'POST', headers: { authorization: REDACTED, accept: 'application/json' } });
  });

  it('redacts a mnemonic or a key wherever a log entry names one, at the top or one level down', () => {
    const { lines, log } = capturingLogger();

    log.info({ mnemonic: 'abandon ability', key: 'k', apiKey: 'a', config: { sponsorMnemonic: ['abandon'], adminApiKey: 'admin' }, port: 8787 }, 'config');
    log.info({ issued: { apiKey: 'shown-once', label: 'wallet' } }, 'key');

    expect(lines[0]).toMatchObject({
      mnemonic: REDACTED,
      key: REDACTED,
      apiKey: REDACTED,
      config: { sponsorMnemonic: REDACTED, adminApiKey: REDACTED },
      port: 8787,
    });
    expect(lines[1]).toMatchObject({ issued: { apiKey: REDACTED, label: 'wallet' } });
  });
});
