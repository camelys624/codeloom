import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DEVICE_OVERVIEW_MAX_BYTES,
  DeviceOverviewSchema,
} from '@agent-workspace/contracts';
import { buildApp } from '../src/app.js';

const ORIGIN = 'http://device-test.local';
const SHA = 'a'.repeat(40);

describe('device pairing, bearer auth and overview', () => {
  let app: FastifyInstance;
  let pool: pg.Pool;
  let admin: pg.Client;
  let stopContainer: (() => Promise<unknown>) | undefined;
  let dataDir: string;
  let cookie: string;
  let userId: string;
  let workspaceId: string;
  const schema = `test_${randomUUID().replaceAll('-', '')}`;

  const web = (method: 'GET' | 'POST', url: string, payload?: unknown) =>
    app.inject({
      method,
      url,
      headers: { cookie, origin: ORIGIN },
      ...(payload === undefined ? {} : { payload }),
    });

  async function pairedDevice(name = 'Passport') {
    const created = await web('POST', '/api/v1/devices', { name });
    expect(created.statusCode).toBe(201);
    const paired = await app.inject({
      method: 'POST',
      url: '/api/v1/devices/pair',
      payload: {
        pairingCode: created.json().pairingCode,
        name,
        firmwareVersion: '1.0.0',
      },
    });
    expect(paired.statusCode).toBe(200);
    return paired.json() as { deviceId: string; deviceToken: string };
  }

  const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

  /** Seeds a Run whose Attempt waits on `count` approvals created one second apart. */
  async function seedApprovals(
    count: number,
    options: { taskTitle?: string; title?: (index: number) => string } = {},
  ): Promise<string[]> {
    const suffix = randomUUID().slice(0, 8);
    const [task, run, attempt, turn] = ['task', 'run', 'att', 'trn'].map(
      (prefix) => `${prefix}_${suffix}`,
    );
    await admin.query(
      'INSERT INTO tasks (id,workspace_id,title,status,created_by,repository_id) VALUES ($1,$2,$3,$4,$5,$6)',
      [
        task,
        workspaceId,
        options.taskTitle ?? 'Approval task',
        'in_progress',
        userId,
        'repo_seed',
      ],
    );
    await admin.query(
      `INSERT INTO runs (id,workspace_id,task_id,requested_by,status,runner_id,agent_profile_id,repository_id,base_commit_sha,frozen_spec)
       VALUES ($1,$2,$3,$4,'waiting_approval','rnr_seed','agp_seed','repo_seed',$5,$6)`,
      [
        run,
        workspaceId,
        task,
        userId,
        SHA,
        {
          taskId: task,
          taskRevision: 1,
          repositoryId: 'repo_seed',
          baseRef: 'main',
          baseCommitSha: SHA,
          runnerId: 'rnr_seed',
          agentProfileId: 'agp_seed',
          engine: 'pi',
          initialPrompt: 'Do it',
          runConfig: { agentProfileId: 'agp_seed' },
        },
      ],
    );
    // Only one live Attempt may hold a profile, so earlier seeds are finished first.
    await admin.query(
      "UPDATE attempts SET status = 'completed', finished_at = now() WHERE agent_profile_id = 'agp_seed' AND status = 'waiting_approval'",
    );
    await admin.query(
      `INSERT INTO attempts (id,workspace_id,run_id,number,runner_id,agent_profile_id,status,branch_name,base_commit_sha,
                             claimed_at,last_heartbeat_at,lease_expires_at)
       VALUES ($1,$2,$3,1,'rnr_seed','agp_seed','waiting_approval',$4,$5,now(),now(),now() + interval '45 seconds')`,
      [attempt, workspaceId, run, `aw/${suffix}/a1`, SHA],
    );
    await admin.query('UPDATE runs SET current_attempt_id = $1 WHERE id = $2', [
      attempt,
      run,
    ]);
    await admin.query(
      "INSERT INTO turns (id,workspace_id,attempt_id,number,prompt,status) VALUES ($1,$2,$3,1,'Do it','waiting_approval')",
      [turn, workspaceId, attempt],
    );
    const ids: string[] = [];
    for (let index = 0; index < count; index++) {
      const id = `apr_${suffix}_${index}`;
      await admin.query(
        `INSERT INTO approval_requests (id,workspace_id,run_id,attempt_id,turn_id,request_id,kind,title,payload,created_at)
         VALUES ($1,$2,$3,$4,$5,$6,'shell',$7,$8, now() - make_interval(secs => $9))`,
        [
          id,
          workspaceId,
          run,
          attempt,
          turn,
          `req_${index}`,
          options.title?.(index) ?? `Run command ${index}`,
          index % 2
            ? { toolCall: { rawInput: { command: `ls -la\n/tmp/${index}` } } }
            : { toolName: 'bash', input: { path: `/work/${index}.txt` } },
          1000 - index,
        ],
      );
      ids.push(id);
    }
    return ids;
  }

  beforeAll(async () => {
    let databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) {
      const container = await new PostgreSqlContainer('postgres:16').start();
      databaseUrl = container.getConnectionUri();
      stopContainer = () => container.stop();
    }
    admin = new pg.Client({ connectionString: databaseUrl });
    await admin.connect();
    await admin.query(`CREATE SCHEMA ${schema}`);
    await admin.query(`SET search_path TO ${schema}`);
    pool = new pg.Pool({
      connectionString: databaseUrl,
      options: `-c search_path=${schema}`,
    });
    dataDir = await mkdtemp(join(tmpdir(), 'aw-device-test-'));
    app = await buildApp({
      pool,
      migrations: true,
      config: {
        databaseUrl,
        publicOrigin: ORIGIN,
        nodeEnv: 'test',
        dataDir,
      },
    });
    await app.ready();
    const registered = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      headers: { origin: ORIGIN },
      payload: {
        email: 'owner@example.com',
        password: 'correct horse battery',
        displayName: 'Owner',
      },
    });
    expect(registered.statusCode).toBe(201);
    const session = registered.cookies.find(
      (entry) => entry.name === 'aw_session',
    );
    cookie = `aw_session=${session?.value}`;
    const me = (await web('GET', '/api/v1/me')).json();
    userId = me.user.id;
    workspaceId = me.workspace.id;
    await admin.query(
      "INSERT INTO repositories (id,workspace_id,name) VALUES ('repo_seed',$1,'Repository')",
      [workspaceId],
    );
    await admin.query(
      "INSERT INTO runners (id,workspace_id,name,created_by,status) VALUES ('rnr_seed',$1,'Runner',$2,'online')",
      [workspaceId, userId],
    );
    await admin.query(
      "INSERT INTO agent_profiles (id,workspace_id,runner_id,engine,display_name) VALUES ('agp_seed',$1,'rnr_seed','pi','Pi')",
      [workspaceId],
    );
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    if (admin) {
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await admin.end();
    }
    await stopContainer?.();
    if (dataDir) await rm(dataDir, { recursive: true, force: true });
  });

  it('pairs once with a single-use code and lists the active device', async () => {
    const created = await web('POST', '/api/v1/devices', {
      name: 'Desk Passport',
    });
    expect(created.statusCode).toBe(201);
    const output = created.json();
    expect(output.pairingCode).toMatch(/^pair_/);
    expect(output.device).toMatchObject({
      status: 'pending',
      pairedAt: null,
      createdBy: userId,
    });
    const pair = () =>
      app.inject({
        method: 'POST',
        url: '/api/v1/devices/pair',
        payload: {
          pairingCode: output.pairingCode,
          name: 'Passport',
          firmwareVersion: '0.3.1',
        },
      });
    const first = await pair();
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({
      deviceId: output.device.id,
      workspaceId,
      workspaceName: expect.any(String),
      deviceToken: expect.stringMatching(/^awd_/),
    });
    expect((await pair()).statusCode).toBe(404);
    const stored = await admin.query(
      'SELECT token_hash FROM devices WHERE id = $1',
      [output.device.id],
    );
    expect(stored.rows[0].token_hash).toMatch(/^[0-9a-f]{64}$/);
    const listed = (await web('GET', '/api/v1/devices')).json();
    expect(listed).toContainEqual(
      expect.objectContaining({
        id: output.device.id,
        name: 'Passport',
        status: 'active',
        firmwareVersion: '0.3.1',
        pairedAt: expect.any(String),
      }),
    );
  });

  it('rejects expired pairing codes and cross-origin device creation', async () => {
    const created = await web('POST', '/api/v1/devices', { name: 'Late' });
    await admin.query(
      `UPDATE device_pairing_codes SET created_at = now() - interval '11 minutes', expires_at = now() - interval '1 minute'
       WHERE device_id = $1`,
      [created.json().device.id],
    );
    const expired = await app.inject({
      method: 'POST',
      url: '/api/v1/devices/pair',
      payload: {
        pairingCode: created.json().pairingCode,
        name: 'Late',
        firmwareVersion: '1',
      },
    });
    expect(expired.statusCode).toBe(404);
    expect(expired.json().error.message).toMatch(/invalid or expired/);
    const crossOrigin = await app.inject({
      method: 'POST',
      url: '/api/v1/devices',
      headers: { cookie, origin: 'http://evil.example' },
      payload: { name: 'Evil' },
    });
    expect(crossOrigin.statusCode).toBe(403);
  });

  it('accepts device tokens only on device routes and keeps runner tokens out', async () => {
    const { deviceId, deviceToken } = await pairedDevice();
    const overview = await app.inject({
      method: 'GET',
      url: '/api/v1/device/overview',
      headers: bearer(deviceToken),
    });
    expect(overview.statusCode).toBe(200);
    const seen = await admin.query(
      'SELECT last_seen_at FROM devices WHERE id = $1',
      [deviceId],
    );
    expect(seen.rows[0].last_seen_at).not.toBeNull();
    for (const url of [
      '/api/v1/tasks',
      '/api/v1/me',
      '/api/v1/runners/me/agent-profiles',
    ]) {
      const response = await app.inject({
        method: 'GET',
        url,
        headers: bearer(deviceToken),
      });
      expect(response.statusCode, url).toBe(401);
    }
    const runner = await web('POST', '/api/v1/runners', {
      name: 'Laptop',
      kind: 'local',
    });
    const runnerPair = await app.inject({
      method: 'POST',
      url: '/api/v1/runners/pair',
      payload: {
        pairingCode: runner.json().pairingCode,
        name: 'Laptop',
        daemonVersion: '0.1.0',
        os: 'linux',
        arch: 'x64',
      },
    });
    const runnerToken = runnerPair.json().runnerToken as string;
    const withRunnerToken = await app.inject({
      method: 'GET',
      url: '/api/v1/device/overview',
      headers: bearer(runnerToken),
    });
    expect(withRunnerToken.statusCode).toBe(401);
    const [approvalId] = await seedApprovals(1);
    const resolveWithRunner = await app.inject({
      method: 'POST',
      url: `/api/v1/approvals/${approvalId}/resolve`,
      headers: bearer(runnerToken),
      payload: { decision: 'allow' },
    });
    expect(resolveWithRunner.statusCode).toBe(401);
  });

  it('rejects revoked and unpaired devices', async () => {
    const { deviceId, deviceToken } = await pairedDevice('Old');
    const revoked = await web('POST', `/api/v1/devices/${deviceId}/revoke`);
    expect(revoked.statusCode).toBe(200);
    expect(revoked.json()).toMatchObject({ id: deviceId, status: 'revoked' });
    const [approvalId] = await seedApprovals(1);
    for (const request of [
      { method: 'GET' as const, url: '/api/v1/device/overview' },
      {
        method: 'POST' as const,
        url: `/api/v1/approvals/${approvalId}/resolve`,
        payload: { decision: 'allow' },
      },
    ]) {
      const response = await app.inject({
        ...request,
        headers: bearer(deviceToken),
      });
      expect(response.statusCode).toBe(401);
    }
    const late = await web('POST', '/api/v1/devices', { name: 'Late revoke' });
    expect(late.json().device.status).toBe('pending');
    await web('POST', `/api/v1/devices/${late.json().device.id}/revoke`);
    const pairRevoked = await app.inject({
      method: 'POST',
      url: '/api/v1/devices/pair',
      payload: {
        pairingCode: late.json().pairingCode,
        name: 'Late revoke',
        firmwareVersion: '1',
      },
    });
    expect(pairRevoked.statusCode).toBe(404);
  });

  it('projects a bounded overview: ordering, truncation and byte budget', async () => {
    await admin.query(
      "UPDATE approval_requests SET status = 'expired' WHERE status = 'pending'",
    );
    // Park earlier tasks as closed; the trigger stamps their updated_at to now().
    await admin.query("UPDATE tasks SET status = 'canceled'");
    const longTitle = (index: number) =>
      `${index}号审批\n\t需要执行命令${'很长的标题'.repeat(40)}`;
    const ids = await seedApprovals(10, {
      taskTitle: `任务${'非常长'.repeat(40)}`,
      title: longTitle,
    });
    // Three older open tasks, then eleven closed tasks newer than everything
    // else: open work must still sort first.
    for (let index = 0; index < 14; index++) {
      await admin.query(
        `INSERT INTO tasks (workspace_id,title,status,created_by,updated_at)
         VALUES ($1,$2,$3,$4, now() + make_interval(secs => $5))`,
        [
          workspaceId,
          `任务 ${index} ${'标题'.repeat(40)}`,
          index < 3 ? 'todo' : 'done',
          userId,
          index < 3 ? -100 - index : 100 - index,
        ],
      );
    }
    const { deviceToken } = await pairedDevice('Overview');
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/device/overview',
      headers: bearer(deviceToken),
    });
    expect(response.statusCode).toBe(200);
    expect(Buffer.byteLength(response.body)).toBeLessThanOrEqual(
      DEVICE_OVERVIEW_MAX_BYTES,
    );
    const overview = DeviceOverviewSchema.parse(response.json());
    const tasksTotal = await admin.query(
      'SELECT count(*)::int AS total FROM tasks WHERE workspace_id = $1',
      [workspaceId],
    );
    expect(overview.approvalsTotal).toBe(10);
    expect(overview.tasksTotal).toBe(tasksTotal.rows[0].total);
    // Oldest first: seeds are created with decreasing age.
    expect(overview.approvals.map((approval) => approval.id)).toEqual(
      ids.slice(0, overview.approvals.length),
    );
    expect(overview.approvals.length).toBeGreaterThan(0);
    // The budget is met by dropping every task before any approval.
    expect(overview.approvals.length < 8).toBe(overview.tasks.length === 0);
    const [first, second] = overview.approvals;
    expect(Array.from(first!.title)).toHaveLength(96);
    expect(first!.title.endsWith('…')).toBe(true);
    expect(first!.title).not.toMatch(/[\n\t]/);
    expect(first!.title.startsWith('0号审批 需要执行命令')).toBe(true);
    expect(first!.detail).toBe('/work/0.txt');
    expect(second!.detail).toBe('ls -la /tmp/1');
    expect(Array.from(first!.taskTitle)).toHaveLength(60);

    // Without oversized approvals the task projection shows open work first.
    await admin.query(
      "UPDATE approval_requests SET status = 'expired' WHERE status = 'pending'",
    );
    const compact = DeviceOverviewSchema.parse(
      (
        await app.inject({
          method: 'GET',
          url: '/api/v1/device/overview',
          headers: bearer(deviceToken),
        })
      ).json(),
    );
    expect(compact.approvals).toEqual([]);
    const expectedTitles = [
      `任务${'非常长'.repeat(40)}`,
      ...[0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(
        (index) => `任务 ${index} ${'标题'.repeat(40)}`,
      ),
    ];
    expect(compact.tasks.map((task) => [task.status, task.runStatus])).toEqual([
      ['in_progress', 'waiting_approval'],
      ['todo', null],
      ['todo', null],
      ['todo', null],
      ...Array.from({ length: 8 }, () => ['done', null]),
    ]);
    expect(compact.tasks.map((task) => task.title)).toEqual(
      expectedTitles.map((title) =>
        Array.from(title).length > 60
          ? `${Array.from(title).slice(0, 59).join('')}…`
          : title,
      ),
    );
  });

  it('resolves as the device creator, audits both paths and rejects double resolve', async () => {
    const { deviceId, deviceToken } = await pairedDevice('Resolver');
    const [viaDevice, viaWeb] = await seedApprovals(2);
    const resolved = await app.inject({
      method: 'POST',
      url: `/api/v1/approvals/${viaDevice}/resolve`,
      headers: bearer(deviceToken),
      payload: { decision: 'allow_always' },
    });
    expect(resolved.statusCode).toBe(200);
    expect(resolved.json()).toMatchObject({
      status: 'approved',
      decidedBy: userId,
    });
    const again = await app.inject({
      method: 'POST',
      url: `/api/v1/approvals/${viaDevice}/resolve`,
      headers: bearer(deviceToken),
      payload: { decision: 'deny' },
    });
    expect(again.statusCode).toBe(409);
    const webResolved = await web(
      'POST',
      `/api/v1/approvals/${viaWeb}/resolve`,
      { decision: 'deny' },
    );
    expect(webResolved.statusCode).toBe(200);
    const audits = await admin.query(
      `SELECT entity_id, actor_type, actor_id, kind, data FROM audit_events
       WHERE entity_type = 'approval' AND entity_id = ANY($1) ORDER BY id`,
      [[viaDevice, viaWeb]],
    );
    expect(audits.rows).toEqual([
      {
        entity_id: viaDevice,
        actor_type: 'human',
        actor_id: userId,
        kind: 'approval.resolved',
        data: { decision: 'allow_always', via: 'device', deviceId },
      },
      {
        entity_id: viaWeb,
        actor_type: 'human',
        actor_id: userId,
        kind: 'approval.resolved',
        data: { decision: 'deny', via: 'web' },
      },
    ]);
  });
});
