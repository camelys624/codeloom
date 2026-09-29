import {
  DEVICE_OVERVIEW_MAX_BYTES,
  DEVICE_TEXT_LIMITS,
  type DeviceOverview,
  type DeviceOverviewApproval,
  type DeviceOverviewTask,
} from '@agent-workspace/contracts';

// Runs of whitespace plus C0/C1 control characters collapse to one space so a
// small LCD never receives line breaks or escape sequences.
const COLLAPSIBLE = /[\s\u0000-\u001f\u007f-\u009f]+/gu;

/** Collapses control characters and truncates to `max` code points, ending in `…` when cut. */
export function deviceText(value: unknown, max: number): string {
  if (typeof value !== 'string') return '';
  const text = value.replace(COLLAPSIBLE, ' ').trim();
  const codePoints = Array.from(text);
  if (codePoints.length <= max) return text;
  return `${codePoints
    .slice(0, max - 1)
    .join('')
    .trimEnd()}…`;
}

const DETAIL_KEYS = ['command', 'path', 'file_path', 'url'] as const;

/**
 * Best-effort one-line summary of an approval payload: Pi stores the tool
 * arguments in `payload.input`, Claude ACP in `payload.toolCall.rawInput`.
 */
export function approvalDetail(payload: unknown): string {
  if (!payload || typeof payload !== 'object') return '';
  const toolCall = 'toolCall' in payload ? payload.toolCall : undefined;
  const input =
    ('input' in payload ? payload.input : undefined) ??
    (toolCall && typeof toolCall === 'object' && 'rawInput' in toolCall
      ? toolCall.rawInput
      : undefined);
  if (typeof input === 'string')
    return deviceText(input, DEVICE_TEXT_LIMITS.approvalDetail);
  if (!input || typeof input !== 'object') return '';
  const fields = new Map<string, unknown>(Object.entries(input));
  const value = DETAIL_KEYS.map((key) => fields.get(key)).find(
    (candidate) => typeof candidate === 'string' && candidate.trim() !== '',
  );
  return deviceText(value, DEVICE_TEXT_LIMITS.approvalDetail);
}

export type OverviewApprovalRow = {
  id: string;
  kind: DeviceOverviewApproval['kind'];
  title: string;
  payload: unknown;
  taskTitle: string;
  runId: string;
  createdAt: string;
  expiresAt: string;
};

export type OverviewTaskRow = {
  id: string;
  title: string;
  status: DeviceOverviewTask['status'];
  runStatus: DeviceOverviewTask['runStatus'];
};

/**
 * Builds the serialized overview. Trailing tasks, then trailing approvals, are
 * dropped until the UTF-8 body fits the device budget; JSON is never cut.
 */
export function serializeDeviceOverview(input: {
  serverTime: string;
  workspaceName: string;
  approvalsTotal: number;
  approvals: OverviewApprovalRow[];
  tasksTotal: number;
  tasks: OverviewTaskRow[];
}): string {
  const overview: DeviceOverview = {
    serverTime: input.serverTime,
    workspaceName: deviceText(
      input.workspaceName,
      DEVICE_TEXT_LIMITS.workspaceName,
    ),
    approvalsTotal: input.approvalsTotal,
    approvals: input.approvals.map((row) => ({
      id: row.id,
      kind: row.kind,
      title: deviceText(row.title, DEVICE_TEXT_LIMITS.approvalTitle),
      detail: approvalDetail(row.payload),
      taskTitle: deviceText(row.taskTitle, DEVICE_TEXT_LIMITS.taskTitle),
      runId: row.runId,
      createdAt: row.createdAt,
      expiresAt: row.expiresAt,
    })),
    tasksTotal: input.tasksTotal,
    tasks: input.tasks.map((row) => ({
      id: row.id,
      title: deviceText(row.title, DEVICE_TEXT_LIMITS.taskTitle),
      status: row.status,
      runStatus: row.runStatus,
    })),
  };
  let body = JSON.stringify(overview);
  while (Buffer.byteLength(body) > DEVICE_OVERVIEW_MAX_BYTES) {
    if (overview.tasks.length) overview.tasks.pop();
    else if (overview.approvals.length) overview.approvals.pop();
    else break;
    body = JSON.stringify(overview);
  }
  return body;
}
