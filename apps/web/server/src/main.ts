import { buildApp, resolveConfig } from './app.js';

const config = resolveConfig();
const app = await buildApp({ config, migrations: true });

try {
  await app.listen({ host: config.host, port: config.port });
  const shutdown = async (signal: string) => {
    app.log.info({ signal }, 'Shutting down');
    await app.close();
    process.exit(0);
  };
  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
} catch (error) {
  app.log.error(error);
  await app.close();
  process.exitCode = 1;
}
