import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from 'pg';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';
import { migrate } from './migrate.js';

describe('PostgreSQL persistence boundaries', () => {
  let client: Client;
  let stopContainer: (() => Promise<unknown>) | undefined;
  let workspaceId: string;
  const schema = `test_${randomUUID().replaceAll('-', '')}`;
  const sha = 'a'.repeat(40);

  beforeAll(async () => {
    let databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) {
      const container = await new PostgreSqlContainer('postgres:16').start();
      databaseUrl = container.getConnectionUri();
      stopContainer = () => container.stop();
    }
    client = new Client({ connectionString: databaseUrl });
    await client.connect();
    await client.query(`CREATE SCHEMA ${schema}`);
    await client.query(`SET search_path TO ${schema}`);
    const first = await migrate({ connection: client });
    const second = await migrate({ connection: client });
    expect(second.applied).toEqual([]);
    expect(second.workspaceId).toBe(first.workspaceId);
    workspaceId = first.workspaceId;
  }, 60_000);

  afterAll(async () => {
    if (client) {
      await client.query('ROLLBACK');
      await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await client.end();
    }
    await stopContainer?.();
  });

  beforeEach(async () => {
    await client.query('BEGIN');
    await client.query(
      "INSERT INTO users (id,email,password_hash,display_name) VALUES ('usr_test','member@example.com','hash','Member')",
    );
    await client.query(
      "INSERT INTO workspace_members (workspace_id,user_id,role) VALUES ($1,'usr_test','admin')",
      [workspaceId],
    );
    await client.query(
      "INSERT INTO repositories (id,workspace_id,name) VALUES ('repo_test',$1,'Repository')",
      [workspaceId],
    );
    await client.query(
      "INSERT INTO runners (id,workspace_id,name,created_by,status) VALUES ('rnr_test',$1,'Runner','usr_test','online')",
      [workspaceId],
    );
    await client.query(
      "INSERT INTO agent_profiles (id,workspace_id,runner_id,engine,display_name) VALUES ('agp_test',$1,'rnr_test','claude-code','Claude')",
      [workspaceId],
    );
    await client.query(
      "INSERT INTO tasks (id,workspace_id,title,created_by,repository_id) VALUES ('task_test',$1,'Task','usr_test','repo_test')",
      [workspaceId],
    );
    for (const id of ['run_first', 'run_second']) {
      const frozenSpec = {
        taskId: 'task_test',
        taskRevision: 1,
        repositoryId: 'repo_test',
        baseRef: 'main',
        baseCommitSha: sha,
        runnerId: 'rnr_test',
        agentProfileId: 'agp_test',
        engine: 'claude-code',
        initialPrompt: 'Implement the change',
        runConfig: { agentProfileId: 'agp_test' },
      };
      await client.query(
        `INSERT INTO runs (id,workspace_id,task_id,requested_by,runner_id,agent_profile_id,repository_id,base_commit_sha,frozen_spec)
        VALUES ($1,$2,'task_test','usr_test','rnr_test','agp_test','repo_test',$3,$4)`,
        [id, workspaceId, sha, frozenSpec],
      );
    }
    await client.query(
      `INSERT INTO attempts (id,workspace_id,run_id,number,runner_id,agent_profile_id,branch_name,base_commit_sha)
      VALUES ('att_first',$1,'run_first',1,'rnr_test','agp_test','aw/first/a1',$2),
             ('att_second',$1,'run_second',1,'rnr_test','agp_test','aw/second/a1',$2)`,
      [workspaceId, sha],
    );
    await client.query(
      "UPDATE runs SET current_attempt_id = CASE id WHEN 'run_first' THEN 'att_first' ELSE 'att_second' END",
    );
  });
  afterEach(async () => {
    await client.query('ROLLBACK');
  });

  it('rejects two queued nonterminal Attempts for the same Run', async () => {
    await expect(
      client.query(
        `INSERT INTO attempts (id,workspace_id,run_id,number,runner_id,agent_profile_id,branch_name,base_commit_sha)
      VALUES ('att_duplicate',$1,'run_first',2,'rnr_test','agp_test','aw/first/a2',$2)`,
        [workspaceId, sha],
      ),
    ).rejects.toMatchObject({
      code: '23505',
      constraint: 'attempts_one_active_run_idx',
    });
  });

  it('allows queued work to share a Profile but rejects two claimed Attempts', async () => {
    await expect(
      client.query(
        `UPDATE attempts SET status='claimed',claimed_at=now(),last_heartbeat_at=now(),lease_expires_at=now()+interval '45 seconds'`,
      ),
    ).rejects.toMatchObject({
      code: '23505',
      constraint: 'attempts_one_active_profile_idx',
    });
  });

  it('rejects cross-workspace repository mappings', async () => {
    await client.query(
      "INSERT INTO workspaces (id,name,slug) VALUES ('ws_foreign','Other','other')",
    );
    await client.query(
      "INSERT INTO repositories (id,workspace_id,name) VALUES ('repo_foreign','ws_foreign','Foreign')",
    );
    await expect(
      client.query(
        "INSERT INTO runner_repositories (workspace_id,runner_id,repository_id,access) VALUES ($1,'rnr_test','repo_foreign','write')",
        [workspaceId],
      ),
    ).rejects.toMatchObject({ code: '23503' });
  });

  it('rejects a Run pointing at another Run’s Attempt at transaction boundary', async () => {
    await client.query(
      "UPDATE runs SET current_attempt_id='att_second' WHERE id='run_first'",
    );
    await expect(
      client.query('SET CONSTRAINTS ALL IMMEDIATE'),
    ).rejects.toMatchObject({
      code: '23503',
      constraint: 'runs_current_attempt_fk',
    });
  });

  it('keeps failed Attempts terminal while permitting a fresh retry', async () => {
    await client.query(
      "UPDATE attempts SET status='failed' WHERE id='att_first'",
    );
    await client.query(
      `INSERT INTO attempts (id,workspace_id,run_id,number,runner_id,agent_profile_id,branch_name,base_commit_sha)
      VALUES ('att_retry',$1,'run_first',2,'rnr_test','agp_test','aw/first/a2',$2)`,
      [workspaceId, sha],
    );
    await expect(
      client.query("UPDATE attempts SET status='queued' WHERE id='att_first'"),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('rejects mutation of frozen execution configuration', async () => {
    await expect(
      client.query(
        "UPDATE runs SET frozen_spec=jsonb_set(frozen_spec,'{initialPrompt}','\"Different prompt\"') WHERE id='run_first'",
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('prevents erasure of audit history', async () => {
    await client.query(
      "INSERT INTO audit_events (workspace_id,actor_type,actor_id,entity_type,entity_id,kind) VALUES ($1,'human','usr_test','run','run_first','run.created')",
      [workspaceId],
    );
    await expect(
      client.query('DELETE FROM audit_events'),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('rejects changed migration bytes and rolls back failed pending DDL', async () => {
    await client.query('ROLLBACK');
    const migrationDirectory = await mkdtemp(join(tmpdir(), 'aw-migrations-'));
    try {
      const original = await readFile(
        new URL('./migrations/0001_initial.sql', import.meta.url),
        'utf8',
      );
      await writeFile(
        join(migrationDirectory, '0001_initial.sql'),
        original + '\n-- modified\n',
      );
      await expect(
        migrate({
          connection: client,
          migrationsDirectory: migrationDirectory,
        }),
      ).rejects.toThrow('checksum mismatch');
      await writeFile(join(migrationDirectory, '0001_initial.sql'), original);
      const archiveMigration = await readFile(
        new URL('./migrations/0002_transcript_archive.sql', import.meta.url),
        'utf8',
      );
      await writeFile(
        join(migrationDirectory, '0002_transcript_archive.sql'),
        archiveMigration,
      );
      await writeFile(
        join(migrationDirectory, '0003_invalid.sql'),
        'CREATE TABLE rollback_probe (id integer); SELECT absent_column FROM rollback_probe;',
      );
      await expect(
        migrate({
          connection: client,
          migrationsDirectory: migrationDirectory,
        }),
      ).rejects.toMatchObject({ code: '42703' });
      expect(
        (await client.query("SELECT to_regclass('rollback_probe') AS relation"))
          .rows[0].relation,
      ).toBeNull();
      expect(
        (
          await client.query(
            'SELECT count(*)::integer AS count FROM schema_migrations',
          )
        ).rows[0].count,
      ).toBe(2);
    } finally {
      await rm(migrationDirectory, { recursive: true, force: true });
    }
  });
});
