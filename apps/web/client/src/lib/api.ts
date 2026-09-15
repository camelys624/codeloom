import {
  AgentProfileSchema,
  ApprovalRequestSchema,
  AttemptSchema,
  CreateAgentProfileInputSchema,
  CreateRunnerInputSchema,
  CreateRunnerOutputSchema,
  CreateRunInputSchema,
  EventsOutputSchema,
  MeOutputSchema,
  PromptInputSchema,
  RegisterRepositoryInputSchema,
  RegisterRepositoryOutputSchema,
  RepositorySchema,
  RunSchema,
  RunSnapshotSchema,
  RunnerSchema,
  TaskSchema,
  TranscriptChunkSchema,
  TranscriptOutputSchema,
  UpdateTaskInputSchema,
  type AgentProfile,
  type ApprovalRequest,
  type CreateAgentProfileInput,
  type CreateRunnerInput,
  type CreateRunInput,
  type MeOutput,
  type RegisterRepositoryInput,
  type Repository,
  type Run,
  type RunSnapshot,
  type Runner,
  type Task,
  type TranscriptChunk,
} from '@agent-workspace/contracts';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

async function request<T>(
  path: string,
  init: RequestInit,
  parse: (value: unknown) => T,
): Promise<T> {
  const response = await fetch(path, {
    credentials: 'include',
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init.headers ?? {}) },
  });
  if (!response.ok) {
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      payload = undefined;
    }
    const error =
      payload && typeof payload === 'object' && 'error' in payload
        ? payload.error
        : undefined;
    const code =
      error && typeof error === 'object' && 'code' in error
        ? String(error.code)
        : 'request_error';
    const message =
      error && typeof error === 'object' && 'message' in error
        ? String(error.message)
        : response.statusText;
    throw new ApiError(response.status, code, message);
  }
  if (response.status === 204) return undefined as T;
  return parse(await response.json());
}

const parseArray =
  <T>(schema: { parse(value: unknown): T }) =>
  (value: unknown): T =>
    schema.parse(value);

export const api = {
  me: () => request('/api/v1/me', {}, MeOutputSchema.parse),
  login: (email: string, password: string) =>
    request(
      '/api/v1/auth/login',
      { method: 'POST', body: JSON.stringify({ email, password }) },
      (value) => value,
    ),
  register: (email: string, password: string, displayName: string) =>
    request(
      '/api/v1/auth/register',
      {
        method: 'POST',
        body: JSON.stringify({ email, password, displayName }),
      },
      (value) => value,
    ),
  logout: () =>
    request('/api/v1/auth/logout', { method: 'POST' }, () => undefined),
  task: (id: string) =>
    request(`/api/v1/tasks/${encodeURIComponent(id)}`, {}, TaskSchema.parse),
  tasks: () =>
    request(
      '/api/v1/tasks',
      {},
      parseArray({
        parse(value: unknown): Task[] {
          return Array.isArray(value)
            ? value.map((item) => TaskSchema.parse(item))
            : (() => {
                throw new Error('Invalid task list');
              })();
        },
      }),
    ),
  createTask: (input: {
    title: string;
    description: string;
    status?: 'backlog' | 'todo';
    priority?: Task['priority'];
    repositoryId: string | null;
  }) =>
    request(
      '/api/v1/tasks',
      { method: 'POST', body: JSON.stringify(input) },
      TaskSchema.parse,
    ),
  taskRuns: (taskId: string) =>
    request(
      `/api/v1/tasks/${encodeURIComponent(taskId)}/runs`,
      {},
      parseArray({
        parse(value: unknown): Run[] {
          return Array.isArray(value)
            ? value.map((item) => RunSchema.parse(item))
            : (() => {
                throw new Error('Invalid Task Run list');
              })();
        },
      }),
    ),
  updateTask: (
    taskId: string,
    input: {
      revision: number;
      title?: string;
      description?: string;
      status?: Task['status'];
      priority?: Task['priority'] | null;
      repositoryId?: string | null;
    },
  ) =>
    request(
      `/api/v1/tasks/${encodeURIComponent(taskId)}`,
      {
        method: 'PATCH',
        body: JSON.stringify(UpdateTaskInputSchema.parse(input)),
      },
      TaskSchema.parse,
    ),
  createRepository: (input: RegisterRepositoryInput) =>
    request(
      '/api/v1/repositories',
      {
        method: 'POST',
        body: JSON.stringify(RegisterRepositoryInputSchema.parse(input)),
      },
      RegisterRepositoryOutputSchema.parse,
    ),
  repositories: () =>
    request(
      '/api/v1/repositories',
      {},
      parseArray({
        parse(value: unknown): Repository[] {
          return Array.isArray(value)
            ? value.map((item) => RepositorySchema.parse(item))
            : (() => {
                throw new Error('Invalid repository list');
              })();
        },
      }),
    ),
  runners: () =>
    request(
      '/api/v1/runners',
      {},
      parseArray({
        parse(value: unknown): Runner[] {
          return Array.isArray(value)
            ? value.map((item) => RunnerSchema.parse(item))
            : (() => {
                throw new Error('Invalid runner list');
              })();
        },
      }),
    ),
  createRunner: (input: CreateRunnerInput) =>
    request(
      '/api/v1/runners',
      {
        method: 'POST',
        body: JSON.stringify(CreateRunnerInputSchema.parse(input)),
      },
      CreateRunnerOutputSchema.parse,
    ),
  profiles: () =>
    request(
      '/api/v1/agent-profiles',
      {},
      parseArray({
        parse(value: unknown): AgentProfile[] {
          return Array.isArray(value)
            ? value.map((item) => AgentProfileSchema.parse(item))
            : (() => {
                throw new Error('Invalid profile list');
              })();
        },
      }),
    ),
  createProfile: (input: CreateAgentProfileInput) =>
    request(
      '/api/v1/agent-profiles',
      {
        method: 'POST',
        body: JSON.stringify(CreateAgentProfileInputSchema.parse(input)),
      },
      AgentProfileSchema.parse,
    ),
  run: (id: string) =>
    request(
      `/api/v1/runs/${encodeURIComponent(id)}`,
      {},
      RunSnapshotSchema.parse,
    ),
  createRun: (taskId: string, input: CreateRunInput) =>
    request(
      `/api/v1/tasks/${encodeURIComponent(taskId)}/runs`,
      {
        method: 'POST',
        body: JSON.stringify(CreateRunInputSchema.parse(input)),
      },
      RunSchema.parse,
    ),
  prompt: (attemptId: string, text: string) =>
    request(
      `/api/v1/attempts/${encodeURIComponent(attemptId)}/prompt`,
      {
        method: 'POST',
        body: JSON.stringify(PromptInputSchema.parse({ text })),
      },
      (value) => value,
    ),
  cancelAttempt: (attemptId: string) =>
    request(
      `/api/v1/attempts/${encodeURIComponent(attemptId)}/cancel`,
      { method: 'POST', body: '{}' },
      (value) => value,
    ),
  closeAttempt: (attemptId: string) =>
    request(
      `/api/v1/attempts/${encodeURIComponent(attemptId)}/close`,
      { method: 'POST', body: '{}' },
      (value) => value,
    ),
  retry: (runId: string, resumeFrom: 'last_commit' | 'base') =>
    request(
      `/api/v1/runs/${encodeURIComponent(runId)}/retry`,
      { method: 'POST', body: JSON.stringify({ resumeFrom }) },
      (value) => value,
    ),
  resolveApproval: (id: string, decision: 'allow' | 'deny' | 'allow_always') =>
    request(
      `/api/v1/approvals/${encodeURIComponent(id)}/resolve`,
      { method: 'POST', body: JSON.stringify({ decision }) },
      ApprovalRequestSchema.parse,
    ),
  events: (attemptId: string, after: number) =>
    request(
      `/api/v1/attempts/${encodeURIComponent(attemptId)}/events?after=${after}`,
      {},
      EventsOutputSchema.parse,
    ),
  transcript: (attemptId: string, afterChunk: number) =>
    request(
      `/api/v1/attempts/${encodeURIComponent(attemptId)}/transcript?afterChunk=${afterChunk}&limit=200`,
      {},
      TranscriptOutputSchema.parse,
    ),
  transcriptBefore: (attemptId: string, beforeChunk: number, limit = 200) =>
    request(
      `/api/v1/attempts/${encodeURIComponent(attemptId)}/transcript?beforeChunk=${beforeChunk}&limit=${limit}`,
      {},
      TranscriptOutputSchema.parse,
    ),
};

export type {
  AgentProfile,
  ApprovalRequest,
  MeOutput,
  Repository,
  RunSnapshot,
  Runner,
  Task,
  TranscriptChunk,
};
