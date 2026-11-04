import { createMysqlPool } from '../config/database';
import { parseEnvironment } from '../config/environment';
import { getAppliedMigrations, loadMigrationFiles, runPendingMigrations } from './migrator';

async function main(): Promise<void> {
  const command = process.argv[2] ?? 'up';
  const env = parseEnvironment(process.env);
  const pool = createMysqlPool(env);

  try {
    if (command === 'up') {
      const result = await runPendingMigrations(pool);
      console.log(
        JSON.stringify({
          status: 'ok',
          appliedCount: result.applied.length,
          applied: result.applied,
          skippedCount: result.skipped.length
        })
      );
    } else if (command === 'status') {
      const files = await loadMigrationFiles();
      const applied = await getAppliedMigrations(pool);
      const appliedSet = new Set(applied.map((a) => a.version));
      const pending = files.filter((f) => !appliedSet.has(f.version)).map((f) => f.version);
      console.log(
        JSON.stringify({
          status: 'ok',
          applied: applied.map((a) => ({ version: a.version, appliedAt: a.appliedAt })),
          pending
        })
      );
    } else {
      console.error(`Unknown migration command: "${command}". Supported: up | status`);
      process.exitCode = 1;
    }
  } finally {
    await pool.end();
  }
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : 'Unknown migration error';
  console.error(JSON.stringify({ status: 'error', message }));
  process.exit(1);
});
