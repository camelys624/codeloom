import {
  AgentCapabilitiesSchema,
  PermissionDecisionSchema,
  TranscriptFrameSchema,
  type AgentAdapter,
  type AgentSessionHandle,
  type PermissionRequest,
  type ProbeInput,
  type RunError,
  type StartSessionInput,
  type TranscriptFrame,
  type TurnResult,
} from '@agent-workspace/contracts';

export type FakeStep =
  | { type: 'frame'; frame: TranscriptFrame }
  | { type: 'delay'; milliseconds: number }
  | {
      type: 'permission';
      request: PermissionRequest;
      expectedDecision?: 'allow' | 'deny' | 'allow_always';
    }
  | { type: 'failure'; error: RunError }
  | { type: 'wait_for_cancel' }
  | { type: 'result'; result: TurnResult };

export type FakeTurn = { expectedPrompt?: string; steps: readonly FakeStep[] };

/** Integration-only script interpreter. Import explicitly from /fake; never a production fallback. */
export class FakeAgentAdapter implements AgentAdapter {
  readonly engine = 'custom' as const;
  constructor(private readonly turns: readonly FakeTurn[]) {}

  async probe(_input: ProbeInput) {
    return AgentCapabilitiesSchema.parse({
      protocol: 'acp',
      engineVersion: 'fake-scripted',
      models: ['fake'],
      supports: {
        cancel: true,
        steer: false,
        permissionRequests: true,
        fileEvents: true,
        planUpdates: true,
      },
      enforcement: {
        filesystem: 'none',
        network: 'none',
        shell: 'none',
        gitPush: 'none',
      },
    });
  }

  async startSession(input: StartSessionInput): Promise<AgentSessionHandle> {
    let index = 0;
    let closed = false;
    let active: AbortController | undefined;
    return {
      prompt: async ({ text, signal }) => {
        if (closed || active)
          throw new Error(
            closed ? 'Fake session closed' : 'Fake Turn already active',
          );
        if (signal.aborted) return { stopReason: 'canceled' };
        const turn = this.turns[index++];
        if (!turn) throw new Error('Fake script exhausted');
        if (turn.expectedPrompt !== undefined && turn.expectedPrompt !== text)
          throw new Error('Unexpected fake prompt');
        const controller = new AbortController();
        active = controller;
        const canceled = Promise.withResolvers<void>();
        const onCancel = () => {
          controller.abort();
          canceled.resolve();
        };
        signal.addEventListener('abort', onCancel, { once: true });
        controller.signal.addEventListener('abort', () => canceled.resolve(), {
          once: true,
        });
        try {
          for (const step of turn.steps) {
            if (controller.signal.aborted) return { stopReason: 'canceled' };
            switch (step.type) {
              case 'frame':
                input.onFrame(TranscriptFrameSchema.parse(step.frame));
                break;
              case 'delay': {
                if (
                  !Number.isFinite(step.milliseconds) ||
                  step.milliseconds < 0
                )
                  throw new Error('Invalid fake delay');
                const elapsed = Promise.withResolvers<void>();
                const timer = input.clock.setTimeout(
                  elapsed.resolve,
                  step.milliseconds,
                );
                try {
                  await Promise.race([elapsed.promise, canceled.promise]);
                } finally {
                  input.clock.clearTimeout(timer);
                }
                break;
              }
              case 'permission': {
                const decision = await Promise.race([
                  input.onPermissionRequest(step.request),
                  canceled.promise.then(() => undefined),
                ]);
                if (decision === undefined) return { stopReason: 'canceled' };
                const parsed = PermissionDecisionSchema.parse(decision);
                if (
                  step.expectedDecision !== undefined &&
                  parsed.decision !== step.expectedDecision
                )
                  throw new Error('Unexpected fake permission decision');
                break;
              }
              case 'failure':
                return { stopReason: 'error', error: step.error };
              case 'wait_for_cancel':
                await canceled.promise;
                return { stopReason: 'canceled' };
              case 'result':
                return step.result;
            }
          }
          if (controller.signal.aborted) return { stopReason: 'canceled' };
          throw new Error(
            'Fake script must end with an explicit result, failure, or cancellation',
          );
        } finally {
          signal.removeEventListener('abort', onCancel);
          active = undefined;
        }
      },
      cancelTurn: async () => {
        active?.abort();
      },
      close: async () => {
        closed = true;
        active?.abort();
      },
    };
  }
}
