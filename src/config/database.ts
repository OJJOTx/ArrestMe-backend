import mysql, { type Pool, type PoolConnection, type PoolOptions } from 'mysql2/promise';
import type { AppEnvironment } from './environment';

export type SqlExecutor = Pool | PoolConnection;

export function createMysqlPool(env: AppEnvironment): Pool {
  const options: PoolOptions = {
    host: env.DATABASE_HOST,
    port: env.DATABASE_PORT,
    database: env.DATABASE_NAME,
    user: env.DATABASE_USER,
    password: env.DATABASE_PASSWORD,
    waitForConnections: true,
    connectionLimit: env.DATABASE_CONNECTION_LIMIT,
    queueLimit: 0,
    timezone: 'Z',
    dateStrings: true,
    charset: 'utf8mb4',
    enableKeepAlive: true,
    keepAliveInitialDelay: 10000
  };

  if (env.DATABASE_SSL) {
    options.ssl = { rejectUnauthorized: true };
  }

  return mysql.createPool(options);
}
