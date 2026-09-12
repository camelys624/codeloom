import type {
  ClaimAttemptsOutput,
  PairRunnerInput,
  RegisterRepositoryInput,
  AgentProfile,
} from '@agent-workspace/contracts';
import {
  AgentProfileSchema,
  ClaimAttemptsOutputSchema,
  PairRunnerOutputSchema,
  RegisterRepositoryOutputSchema,
  UploadArtifactOutputSchema,
} from '@agent-workspace/contracts';
import type { RunnerCredentials } from './config.js';

export async function apiRequest<T>(
  credentials: RunnerCredentials,
  path: string,
  init: RequestInit,
  parse: (value: unknown) => T,
): Promise<T> {
  const response = await fetch(new URL(path, credentials.server), {
    ...init,
    headers: {
      Authorization: `Bearer ${credentials.runnerToken}`,
      ...(init.body instanceof FormData
        ? {}
        : { 'Content-Type': 'application/json' }),
      ...(init.headers ?? {}),
    },
  });
  if (!response.ok)
    throw new Error(`Runner API ${response.status}: ${await response.text()}`);
  if (response.status === 204) return undefined as T;
  return parse(await response.json());
}

export async function pair(server: string, input: PairRunnerInput) {
  const response = await fetch(new URL('/api/v1/runners/pair', server), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (!response.ok)
    throw new Error(
      `Pairing failed (${response.status}): ${await response.text()}`,
    );
  return PairRunnerOutputSchema.parse(await response.json());
}

export async function registerRepository(
  credentials: RunnerCredentials,
  input: RegisterRepositoryInput,
) {
  return apiRequest(
    credentials,
    '/api/v1/runners/me/repositories',
    { method: 'POST', body: JSON.stringify(input) },
    RegisterRepositoryOutputSchema.parse,
  );
}

export async function profiles(
  credentials: RunnerCredentials,
): Promise<AgentProfile[]> {
  const value = await apiRequest(
    credentials,
    '/api/v1/runners/me/agent-profiles',
    {},
    (input) => input,
  );
  if (!Array.isArray(value))
    throw new Error('Runner profile response is not an array');
  return value.map((item) => AgentProfileSchema.parse(item));
}

export async function claim(
  credentials: RunnerCredentials,
  capacity: number,
): Promise<ClaimAttemptsOutput> {
  return apiRequest(
    credentials,
    '/api/v1/runners/me/claim',
    { method: 'POST', body: JSON.stringify({ capacity }) },
    ClaimAttemptsOutputSchema.parse,
  );
}

export async function uploadArtifact(
  credentials: RunnerCredentials,
  attemptId: string,
  fields: { kind: string; turnId?: string; sha256: string },
  body: Uint8Array,
): Promise<string> {
  const form = new FormData();
  form.set('kind', fields.kind);
  if (fields.turnId) form.set('turnId', fields.turnId);
  form.set('sha256', fields.sha256);
  form.set('file', new Blob([body]), 'artifact');
  const result = await apiRequest(
    credentials,
    `/api/v1/attempts/${encodeURIComponent(attemptId)}/artifacts`,
    { method: 'POST', body: form },
    UploadArtifactOutputSchema.parse,
  );
  return result.artifactId;
}
