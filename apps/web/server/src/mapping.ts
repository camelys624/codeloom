import type {
  AgentProfile,
  ApprovalRequest,
  Artifact,
  Attempt,
  Repository,
  Run,
  Runner,
  Task,
  Turn,
  User,
  Workspace,
  WorkspaceMember,
} from '@agent-workspace/contracts';
import { iso, nullableIso, jsonObject, jsonValue } from './db.js';

type Row = Record<string, unknown>;

export function mapUser(row: Row): User {
  return {
    id: String(row.id),
    email: String(row.email),
    displayName: String(row.display_name),
    createdAt: iso(row.created_at),
  };
}

export function mapWorkspace(row: Row): Workspace {
  return {
    id: String(row.id),
    name: String(row.name),
    slug: String(row.slug),
    createdAt: iso(row.created_at),
  };
}

export function mapMembership(row: Row): WorkspaceMember {
  return {
    workspaceId: String(row.workspace_id),
    userId: String(row.user_id),
    role: row.role as WorkspaceMember['role'],
  };
}

export function mapRepository(row: Row): Repository {
  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id),
    name: String(row.name),
    remoteUrl: row.remote_url === null ? null : String(row.remote_url),
    defaultRef: String(row.default_ref),
    status: row.status as Repository['status'],
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

export function mapRunner(row: Row): Runner {
  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id),
    name: String(row.name),
    kind: row.kind as Runner['kind'],
    status: row.status as Runner['status'],
    ...(row.daemon_version
      ? { daemonVersion: String(row.daemon_version) }
      : {}),
    ...(row.os ? { os: String(row.os) } : {}),
    ...(row.arch ? { arch: String(row.arch) } : {}),
    maxConcurrency: Number(row.max_concurrency),
    ...(row.last_seen_at ? { lastSeenAt: iso(row.last_seen_at) } : {}),
    createdBy: String(row.created_by),
    createdAt: iso(row.created_at),
  };
}

export function mapAgentProfile(row: Row): AgentProfile {
  const profile: AgentProfile = {
    id: String(row.id),
    workspaceId: String(row.workspace_id),
    runnerId: String(row.runner_id),
    engine: row.engine as AgentProfile['engine'],
    displayName: String(row.display_name),
    launch: row.launch as AgentProfile['launch'],
    ...(row.default_model ? { defaultModel: String(row.default_model) } : {}),
  };
  if (row.capability_snapshot) {
    profile.capabilitySnapshot =
      row.capability_snapshot as AgentProfile['capabilitySnapshot'];
  }
  if (row.capability_reported_at)
    profile.capabilityReportedAt = iso(row.capability_reported_at);
  return profile;
}

export function mapTask(row: Row): Task {
  const task: Task = {
    id: String(row.id),
    workspaceId: String(row.workspace_id),
    title: String(row.title),
    description: String(row.description),
    status: row.status as Task['status'],
    ...(row.priority ? { priority: row.priority as Task['priority'] } : {}),
    repositoryId: row.repository_id === null ? null : String(row.repository_id),
    revision: Number(row.revision),
    createdBy: String(row.created_by),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
  if (row.last_run_config)
    task.lastRunConfig = row.last_run_config as Task['lastRunConfig'];
  return task;
}

export function mapRun(row: Row): Run {
  const run: Run = {
    id: String(row.id),
    taskId: String(row.task_id),
    workspaceId: String(row.workspace_id),
    requestedBy: String(row.requested_by),
    status: row.status as Run['status'],
    frozenSpec: row.frozen_spec as Run['frozenSpec'],
    ...(row.current_attempt_id
      ? { currentAttemptId: String(row.current_attempt_id) }
      : {}),
    createdAt: iso(row.created_at),
    ...(row.started_at ? { startedAt: iso(row.started_at) } : {}),
    ...(row.finished_at ? { finishedAt: iso(row.finished_at) } : {}),
  };
  return run;
}

export function mapAttempt(row: Row): Attempt {
  const attempt: Attempt = {
    id: String(row.id),
    runId: String(row.run_id),
    number: Number(row.number),
    runnerId: String(row.runner_id),
    agentProfileId: String(row.agent_profile_id),
    status: row.status as Attempt['status'],
    resumeFrom: row.resume_from as Attempt['resumeFrom'],
    branchName: String(row.branch_name),
    baseCommitSha: String(row.base_commit_sha),
    ...(row.head_commit_sha
      ? { headCommitSha: String(row.head_commit_sha) }
      : {}),
    ...(row.not_before ? { notBefore: iso(row.not_before) } : {}),
    createdAt: iso(row.created_at),
    ...(row.claimed_at ? { claimedAt: iso(row.claimed_at) } : {}),
    ...(row.started_at ? { startedAt: iso(row.started_at) } : {}),
    ...(row.finished_at ? { finishedAt: iso(row.finished_at) } : {}),
    ...(row.lease_expires_at
      ? { leaseExpiresAt: iso(row.lease_expires_at) }
      : {}),
    ...(row.last_heartbeat_at
      ? { lastHeartbeatAt: iso(row.last_heartbeat_at) }
      : {}),
  };
  if (row.enforcement)
    attempt.enforcement = row.enforcement as Attempt['enforcement'];
  if (row.cancel_requested_at)
    attempt.cancelRequestedAt = iso(row.cancel_requested_at);
  if (row.error) attempt.error = row.error as Attempt['error'];
  return attempt;
}

export function mapTurn(row: Row): Turn {
  const turn: Turn = {
    id: String(row.id),
    attemptId: String(row.attempt_id),
    number: Number(row.number),
    prompt: String(row.prompt),
    status: row.status as Turn['status'],
    startedAt: iso(row.started_at),
    ...(row.finished_at ? { finishedAt: iso(row.finished_at) } : {}),
  };
  if (row.usage) turn.usage = row.usage as Turn['usage'];
  if (row.diff_stats) turn.diffStats = row.diff_stats as Turn['diffStats'];
  if (row.commit_sha) turn.commitSha = String(row.commit_sha);
  if (row.patch_artifact_id)
    turn.patchArtifactId = String(row.patch_artifact_id);
  return turn;
}

export function mapApproval(row: Row): ApprovalRequest {
  const approval: ApprovalRequest = {
    id: String(row.id),
    workspaceId: String(row.workspace_id),
    runId: String(row.run_id),
    attemptId: String(row.attempt_id),
    turnId: String(row.turn_id),
    requestId: String(row.request_id),
    kind: row.kind as ApprovalRequest['kind'],
    title: String(row.title),
    payload: jsonValue(row.payload) as ApprovalRequest['payload'],
    status: row.status as ApprovalRequest['status'],
    expiresAt: iso(row.expires_at),
    createdAt: iso(row.created_at),
  };
  if (row.decided_by) approval.decidedBy = String(row.decided_by);
  if (row.decided_at) approval.decidedAt = iso(row.decided_at);
  return approval;
}

export function mapArtifact(row: Row): Artifact {
  const artifact: Artifact = {
    id: String(row.id),
    workspaceId: String(row.workspace_id),
    runId: String(row.run_id),
    attemptId: String(row.attempt_id),
    kind: row.kind as Artifact['kind'],
    blobRef: String(row.blob_ref),
    sizeBytes: Number(row.size_bytes),
    sha256: String(row.sha256),
    mimeType: String(row.mime_type),
    createdAt: iso(row.created_at),
  };
  if (row.turn_id) artifact.turnId = String(row.turn_id);
  return artifact;
}

export function mapRunEvent(row: Row): Record<string, unknown> {
  const event: Record<string, unknown> = {
    id: String(row.id),
    workspaceId: String(row.workspace_id),
    runId: String(row.run_id),
    attemptId: String(row.attempt_id),
    sequence: Number(row.sequence),
    clientSeq: row.client_seq === null ? null : Number(row.client_seq),
    type: String(row.type),
    occurredAt: iso(row.occurred_at),
    createdAt: iso(row.created_at),
    payload: jsonValue(row.payload),
  };
  if (row.turn_id) event.turnId = String(row.turn_id);
  return event;
}

export function mapJsonObject(value: unknown): Record<string, unknown> {
  const mapped = jsonObject(value);
  if (!mapped) throw new Error('Expected JSON object');
  return mapped;
}

export function mapNullableTimestamp(value: unknown): string | undefined {
  return nullableIso(value);
}
