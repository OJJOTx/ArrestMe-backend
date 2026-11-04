import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { buildApp } from '../app';
import { parseEnvironment } from '../config/environment';
import { DisabledFcmTransport } from '../config/firebase';
import { InMemoryDataStore } from '../database/memory-datastore';

async function main(): Promise<void> {
  const checkOnly = process.argv.includes('--check');

  const env = parseEnvironment({
    NODE_ENV: 'test',
    PORT: '3000',
    LOG_LEVEL: 'silent',
    APP_VERSION: '0.2.0',
    JWT_ACCESS_SECRET: 'openapi_generation_secret_minimum_32_characters_long',
    MAINTENANCE_API_KEY: 'openapi_maintenance_secret_minimum_32_characters_long',
    FIREBASE_ENABLED: 'false'
  });

  const store = new InMemoryDataStore();
  const app = await buildApp({
    env,
    store,
    fcmTransport: new DisabledFcmTransport(),
    enableRateLimit: false
  });

  await app.ready();
  const spec = app.swagger();
  const formatted = `${JSON.stringify(spec, null, 2)}\n`;
  await app.close();

  const outPath = path.resolve(__dirname, '../../docs/openapi.json');
  await mkdir(path.dirname(outPath), { recursive: true });

  if (checkOnly) {
    let existing = '';
    try {
      existing = await readFile(outPath, 'utf8');
    } catch {
      console.error(`OpenAPI specification missing at ${outPath}. Run: npm run openapi:generate`);
      process.exit(1);
    }
    if (existing.replace(/\r\n/g, '\n') !== formatted) {
      console.error('OpenAPI specification is out of date. Run: npm run openapi:generate');
      process.exit(1);
    }
    console.log('OpenAPI 3.1 specification verified up to date.');
    return;
  }

  await writeFile(outPath, formatted, 'utf8');
  console.log(`Generated OpenAPI 3.1 specification at ${outPath}`);
}

void main();
