import { config as loadEnvFile } from 'dotenv';
import { Cometa } from './cometa.js';
import { loadConfig } from './config.js';
import { createLogger } from './logger.js';
import { createService } from './service.js';

loadEnvFile({ quiet: true });

const main = async (): Promise<void> => {
  const logger = createLogger();
  const config = loadConfig();
  delete process.env.SPONSOR_MNEMONIC;
  delete process.env.BLOCKFROST_PREPROD_PROJECT_ID;
  delete process.env.ADMIN_API_KEY;

  await Cometa.ready();

  const provider = new Cometa.BlockfrostProvider({
    network: Cometa.NetworkMagic.Preprod,
    projectId: config.blockfrostProjectId,
  });

  const service = await createService({ config, provider, logger });
  await service.start();

  service.app.listen(config.port, () => {
    logger.info({ port: config.port, address: service.serviceWallet.address }, 'Fee sponsor service listening');
  });
};

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : 'Unknown startup error';
  console.error(`Fee sponsor service failed to start: ${message}`);
  process.exit(1);
});
