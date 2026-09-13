import { describe, expect, it } from 'vitest';
import type { AgentProfile } from '@agent-workspace/contracts';
import { profiles } from '../src/http.js';

describe('Runner profile discovery', () => {
  it('reads Pi profiles from the server endpoint', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify([
          {
            id: 'agp_pi',
            workspaceId: 'ws_test',
            runnerId: 'rnr_test',
            engine: 'pi',
            displayName: 'Pi',
            launch: { kind: 'managed' },
            defaultModel: 'gpt-5.6-luna',
          } satisfies AgentProfile,
        ]),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )) as typeof fetch;
    try {
      const result = await profiles({
        server: 'http://127.0.0.1:5181',
        runnerId: 'rnr_test',
        workspaceId: 'ws_test',
        runnerToken: 'token',
        name: 'runner',
        daemonVersion: 'test',
      });
      expect(result[0]?.engine).toBe('pi');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
