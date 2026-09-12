import { Pool, type PoolClient, type QueryResultRow } from 'pg';

export type DbExecutor = Pool | PoolClient;

export function createPool(databaseUrl = process.env.DATABASE_URL): Pool {
  if (!databaseUrl) throw new Error('DATABASE_URL is required');
  return new Pool({ connectionString: databaseUrl, max: 10 });
}

export async function transaction<T>(
  pool: Pool,
  callback: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackError) {
      throw new AggregateError(
        [error, rollbackError],
        'Transaction failed and rollback failed',
      );
    }
    throw error;
  } finally {
    client.release();
  }
}

export function one<T extends QueryResultRow>(
  result: { rows: T[] },
  message: string,
): T {
  const row = result.rows[0];
  if (!row) throw Object.assign(new Error(message), { statusCode: 404 });
  return row;
}

export function iso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  const parsed = new Date(String(value));
  if (Number.isNaN(parsed.valueOf()))
    throw new Error(`Invalid timestamp: ${String(value)}`);
  return parsed.toISOString();
}

export function nullableIso(value: unknown): string | undefined {
  return value === null || value === undefined ? undefined : iso(value);
}

export function jsonObject(
  value: unknown,
): Record<string, unknown> | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value !== 'object' || Array.isArray(value))
    throw new Error('Expected JSON object');
  return value as Record<string, unknown>;
}

export function jsonValue(value: unknown): unknown {
  return value === null || value === undefined ? undefined : value;
}
