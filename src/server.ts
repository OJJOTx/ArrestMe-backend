import { buildApp } from './app';
import { createMysqlPool } from './config/database';
import { parseEnvironment } from './config/environment';
import { runPendingMigrations } from './database/migrator';
import { MysqlDataStore } from './database/mysql-datastore';

async function startServer(): Promise<void> {
  const env = parseEnvironment(process.env);
  const pool = createMysqlPool(env);
  const store = new MysqlDataStore(pool);

  const app = await buildApp({ env, store });

  const dbReachable = await store.ping();
  if (!dbReachable) {
    app.log.error(
      { host: env.DATABASE_HOST, port: env.DATABASE_PORT, database: env.DATABASE_NAME },
      'Initial MySQL ping failed during startup; check DATABASE_* environment variables'
    );
    if (env.NODE_ENV === 'production') {
      await store.close();
      process.exit(1);
    }
  } else if (env.AUTO_MIGRATE_ON_STARTUP) {
    const migrationResult = await runPendingMigrations(pool);
    app.log.info(
      { applied: migrationResult.applied, skippedCount: migrationResult.skipped.length },
      'Startup SQL migration check completed'
    );
  }

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    app.log.info({ signal }, 'Received shutdown signal; closing HTTP server and MySQL pool');
    try {
      await app.close();
      await store.close();
      process.exit(0);
    } catch (err) {
      app.log.error({ err }, 'Error during graceful shutdown');
      process.exit(1);
    }
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  try {
    await app.listen({ port: env.PORT, host: env.HOST });
    app.log.info(
      { port: env.PORT, host: env.HOST, env: env.NODE_ENV, version: env.APP_VERSION },
      'ArrestMe API server listening'
    );
  } catch (err) {
    app.log.fatal({ err }, 'Failed to bind HTTP server');
    await store.close();
    process.exit(1);
  }
}

void startServer();
