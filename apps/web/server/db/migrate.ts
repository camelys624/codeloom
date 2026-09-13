import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Client, type PoolClient } from 'pg';

export interface MigrateOptions {
  /** A dedicated, connected client with no transaction in progress; never a Pool. */
  connection?: Client | PoolClient;
  databaseUrl?: string;
  /** Defaults to migrations/ adjacent to this module in both source and dist. */
  migrationsDirectory?: string | URL;
  workspace?: { name: string; slug: string };
}

export interface MigrationResult {
  applied: string[];
  workspaceId: string;
}

interface Migration {
  name: string;
  checksum: string;
  sql: string;
}

async function readMigrations(directory: string | URL): Promise<Migration[]> {
  const path =
    typeof directory === 'string' ? directory : fileURLToPath(directory);
  const entries = await readdir(path, { withFileTypes: true });
  const names = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.sql'))
    .map((entry) => entry.name)
    .sort();
  if (names.length === 0) {
    throw new Error('No SQL migrations found');
  }
  const versions = new Set<string>();
  for (const name of names) {
    if (!/^[0-9]{4}_[a-z][a-z0-9_]*\.sql$/.test(name)) {
      throw new Error(`Invalid migration filename: ${name}`);
    }
    const version = name.slice(0, 4);
    if (versions.has(version)) {
      throw new Error(`Duplicate migration version: ${version}`);
    }
    versions.add(version);
  }
  return Promise.all(
    names.map(async (name) => {
      const bytes = await readFile(join(path, name));
      const sql = bytes.toString('utf8');
      if (sql.trim().length === 0) {
        throw new Error(`Empty migration: ${name}`);
      }
      return {
        name,
        sql,
        checksum: createHash('sha256').update(bytes).digest('hex'),
      };
    }),
  );
}

/** Applies the complete pending suffix and first Workspace in one locked transaction. */
export async function migrate(
  options: MigrateOptions = {},
): Promise<MigrationResult> {
  const migrations = await readMigrations(
    options.migrationsDirectory ?? new URL('./migrations/', import.meta.url),
  );
  const databaseUrl = options.databaseUrl ?? process.env.DATABASE_URL;
  if (!options.connection && !databaseUrl) {
    throw new Error('DATABASE_URL is required');
  }
  const ownedClient = options.connection
    ? undefined
    : new Client({ connectionString: databaseUrl });
  const client = options.connection ?? ownedClient;
  if (!client) {
    throw new Error('A database connection is required');
  }
  const workspace = options.workspace ?? {
    name: 'Codeloom',
    slug: 'default',
  };
  if (!workspace.name.trim() || !workspace.slug.trim()) {
    throw new Error('Bootstrap workspace name and slug must not be empty');
  }
  let transactionStarted = false;
  try {
    if (ownedClient) await ownedClient.connect();
    await client.query('BEGIN');
    transactionStarted = true;
    // Stable application-specific namespace; held through DDL, history and bootstrap.
    await client.query('SELECT pg_advisory_xact_lock($1, $2)', [0x41574442, 1]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name text PRIMARY KEY,
        checksum text NOT NULL CHECK (checksum ~ '^[0-9a-f]{64}$'),
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    const history = await client.query<{ name: string; checksum: string }>(
      'SELECT name, checksum FROM schema_migrations ORDER BY name COLLATE "C"',
    );
    for (const [index, recorded] of history.rows.entries()) {
      const migration = migrations[index];
      if (!migration || migration.name !== recorded.name) {
        throw new Error(
          `Migration history is not a prefix of the available migrations at ${recorded.name}`,
        );
      }
      if (migration.checksum !== recorded.checksum) {
        throw new Error(`Migration checksum mismatch: ${recorded.name}`);
      }
    }
    const applied: string[] = [];
    for (const migration of migrations.slice(history.rows.length)) {
      await client.query(migration.sql);
      await client.query(
        'INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)',
        [migration.name, migration.checksum],
      );
      applied.push(migration.name);
    }
    const existing = await client.query<{ id: string }>(
      'SELECT id FROM workspaces ORDER BY created_at, id LIMIT 1',
    );
    let workspaceId = existing.rows[0]?.id;
    if (!workspaceId) {
      const inserted = await client.query<{ id: string }>(
        'INSERT INTO workspaces (name, slug) VALUES ($1, $2) RETURNING id',
        [workspace.name, workspace.slug],
      );
      workspaceId = inserted.rows[0]?.id;
      if (!workspaceId)
        throw new Error('Workspace bootstrap did not return an id');
    }
    await client.query('COMMIT');
    transactionStarted = false;
    return { applied, workspaceId };
  } catch (error) {
    if (transactionStarted) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          'Migration failed and rollback failed',
        );
      }
    }
    throw error;
  } finally {
    if (ownedClient) await ownedClient.end();
  }
}

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  try {
    const result = await migrate();
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Database migration failed';
    const databaseUrl = process.env.DATABASE_URL;
    process.stderr.write(
      `${databaseUrl ? message.replaceAll(databaseUrl, '[DATABASE_URL]') : message}\n`,
    );
    process.exitCode = 1;
  }
}
