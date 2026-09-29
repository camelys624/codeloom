import { describe, expect, it } from 'vitest';
import {
  DEVICE_OVERVIEW_MAX_BYTES,
  DeviceOverviewSchema,
} from '@agent-workspace/contracts';
import {
  approvalDetail,
  deviceText,
  serializeDeviceOverview,
} from '../src/device-overview.js';

describe('device overview projection', () => {
  it('collapses control characters and truncates on code points', () => {
    expect(deviceText('a\r\n\u0007\tb  c', 10)).toBe('a b c');
    // Astral characters count once; the ellipsis stays inside the limit.
    expect(deviceText('😀'.repeat(10), 5)).toBe('😀😀😀😀…');
    expect(deviceText('😀'.repeat(5), 5)).toBe('😀'.repeat(5));
    expect(deviceText(undefined, 5)).toBe('');
  });

  it('summarizes Pi and Claude payloads and falls back to empty', () => {
    expect(
      approvalDetail({ toolName: 'bash', input: { command: 'ls\n-la' } }),
    ).toBe('ls -la');
    expect(
      approvalDetail({
        toolCall: { rawInput: { url: 'https://example.com' } },
      }),
    ).toBe('https://example.com');
    expect(
      approvalDetail({ toolCall: { rawInput: { file_path: '/a' } } }),
    ).toBe('/a');
    expect(approvalDetail({ input: { unrelated: 1 } })).toBe('');
    expect(approvalDetail(null)).toBe('');
  });

  it('drops trailing tasks before trailing approvals to fit the byte budget', () => {
    const wide = (length: number) => '审'.repeat(length);
    const body = serializeDeviceOverview({
      serverTime: new Date(0).toISOString(),
      workspaceName: wide(100),
      approvalsTotal: 20,
      approvals: Array.from({ length: 8 }, (_, index) => ({
        id: `apr_${index}`,
        kind: 'shell' as const,
        title: wide(200),
        payload: { input: { command: wide(400) } },
        taskTitle: wide(100),
        runId: `run_${index}`,
        createdAt: new Date(index * 1000).toISOString(),
        expiresAt: new Date(index * 1000 + 60_000).toISOString(),
      })),
      tasksTotal: 30,
      tasks: Array.from({ length: 12 }, (_, index) => ({
        id: `task_${index}`,
        title: wide(100),
        status: 'todo' as const,
        runStatus: null,
      })),
    });
    expect(Buffer.byteLength(body)).toBeLessThanOrEqual(
      DEVICE_OVERVIEW_MAX_BYTES,
    );
    const overview = DeviceOverviewSchema.parse(JSON.parse(body));
    expect(overview.tasks).toEqual([]);
    expect(overview.approvals.length).toBeGreaterThan(0);
    expect(overview.approvals.length).toBeLessThan(8);
    expect(overview.approvals.map((approval) => approval.id)).toEqual(
      Array.from(
        { length: overview.approvals.length },
        (_, index) => `apr_${index}`,
      ),
    );
    expect(overview.approvalsTotal).toBe(20);
    expect(overview.tasksTotal).toBe(30);
    expect(Array.from(overview.workspaceName)).toHaveLength(40);
    expect(Array.from(overview.approvals[0]!.detail)).toHaveLength(200);
  });
});
