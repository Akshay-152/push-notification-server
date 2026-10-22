import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from './config/index.js';
import { initDatabase } from './database/db.js';
import { createApp } from './app.js';
import { createLogger } from './utils/logger.js';

const logger = createLogger('server');

function main() {
  const config = loadConfig();

  if (config.databasePath !== ':memory:') {
    fs.mkdirSync(path.dirname(path.resolve(config.databasePath)), { recursive: true });
  }
  const db = initDatabase(config.databasePath);
  logger.info('Database ready', { path: config.databasePath });

  const { app, services, sessionStore } = createApp({ config, db, logger });

  // Persistent scheduler: recovers due scheduled sends after restarts.
  services.notificationService.startScheduler();

  const server = app.listen(config.port, () => {
    logger.info(`Server listening on http://localhost:${config.port}`, {
      site: config.siteUrl,
      env: config.nodeEnv,
      cookieSecure: config.cookieSecure,
    });
  });

  let shuttingDown = false;
  function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`${signal} received - shutting down`);
    services.notificationService.stopScheduler();
    server.close(() => {
      sessionStore.stopCleanup();
      try {
        db.close();
      } catch {
        /* already closed */
      }
      process.exit(0);
    });
    // Do not hang forever on open keep-alive connections.
    setTimeout(() => process.exit(1), 10_000).unref();
  }

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

try {
  main();
} catch (err) {
  logger.error('Fatal startup error', err);
  process.exit(1);
}
