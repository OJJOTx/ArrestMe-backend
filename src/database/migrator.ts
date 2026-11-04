import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Pool, RowDataPacket } from 'mysql2/promise';
import { toMysqlDateTime } from '../shared/time';

export interface MigrationFile {
  version: string;
  filename: string;
  fullPath: string;
  checksum: string;
  statements: string[];
}

export interface AppliedMigration {
  version: string;
  checksum: string;
  appliedAt: string;
}

export function splitSqlStatements(sqlContent: string): string[] {
  const lines = sqlContent
    .split(/\r?\n/)
    .filter((line) => !line.trimStart().startsWith('--'));

  return lines
    .join('\n')
    .split(';')
    .map((stmt) => stmt.trim())
    .filter((stmt) => stmt.length > 0);
}

export async function loadMigrationFiles(
  migrationsDir: string = path.resolve(__dirname, '../../database/migrations')
): Promise<MigrationFile[]> {
  const entries = await readdir(migrationsDir, { withFileTypes: true });
  const sqlFiles = entries
    .filter((e) => e.isFile() && e.name.endsWith('.sql'))
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b));

  const migrations: MigrationFile[] = [];
  for (const filename of sqlFiles) {
    const fullPath = path.join(migrationsDir, filename);
    const raw = await readFile(fullPath, 'utf8');
    const normalized = raw.replace(/\r\n/g, '\n');
    const checksum = createHash('sha256').update(normalized, 'utf8').digest('hex');
    const statements = splitSqlStatements(normalized);
    migrations.push({
      version: filename.replace(/\.sql$/i, ''),
      filename,
      fullPath,
      checksum,
      statements
    });
  }

  return migrations;
}

export async function ensureMigrationsTable(pool: Pool): Promise<void> {
  await pool.execute(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version VARCHAR(128) NOT NULL,
      checksum CHAR(64) NOT NULL,
      applied_at DATETIME(3) NOT NULL,
      PRIMARY KEY (version)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
}

export async function getAppliedMigrations(pool: Pool): Promise<AppliedMigration[]> {
  await ensureMigrationsTable(pool);
  const [rows] = await pool.execute<RowDataPacket[]>(
    'SELECT version, checksum, applied_at FROM schema_migrations ORDER BY version ASC'
  );
  return rows.map((r) => ({
    version: String(r.version),
    checksum: String(r.checksum),
    appliedAt: String(r.applied_at)
  }));
}

export async function runPendingMigrations(
  pool: Pool,
  migrationsDir?: string
): Promise<{ applied: string[]; skipped: string[] }> {
  const files = await loadMigrationFiles(migrationsDir);
  const appliedList = await getAppliedMigrations(pool);
  const appliedMap = new Map(appliedList.map((m) => [m.version, m]));

  const applied: string[] = [];
  const skipped: string[] = [];

  for (const file of files) {
    const existing = appliedMap.get(file.version);
    if (existing) {
      if (existing.checksum !== file.checksum) {
        throw new Error(
          `Migration checksum mismatch for "${file.version}": expected ${existing.checksum}, found ${file.checksum}. Never mutate already-applied migrations.`
        );
      }
      skipped.push(file.version);
      continue;
    }

    const conn = await pool.getConnection();
    try {
      for (const statement of file.statements) {
        await conn.query(statement);
      }
      await conn.execute(
        'INSERT INTO schema_migrations (version, checksum, applied_at) VALUES (?, ?, ?)',
        [file.version, file.checksum, toMysqlDateTime(new Date())]
      );
      applied.push(file.version);
    } finally {
      conn.release();
    }
  }

  return { applied, skipped };
}
