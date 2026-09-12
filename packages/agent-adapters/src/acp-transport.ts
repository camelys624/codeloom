import { z } from 'zod';
import { StringDecoder } from 'node:string_decoder';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type { Clock } from '@agent-workspace/contracts';

const MessageSchema = z
  .object({
    jsonrpc: z.literal('2.0'),
    id: z.union([z.number().int(), z.string()]).optional(),
    method: z.string().optional(),
    params: z.unknown().optional(),
    result: z.unknown().optional(),
    error: z
      .object({
        code: z.number(),
        message: z.string(),
        data: z.unknown().optional(),
      })
      .optional(),
  })
  .strict();

type RequestId = string | number;
type Pending = {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: NodeJS.Timeout;
};

export class AcpError extends Error {
  constructor(
    message: string,
    readonly rpcCode?: number,
  ) {
    super(message);
    this.name = 'AcpError';
  }
}

/** The SDK's default transport/connection prints malformed messages verbatim. This strict
 * transport uses the pinned SDK schemas at call sites but never logs wire payloads.
 */
export class AcpTransport {
  private serial = 0;
  private readonly pending = new Map<RequestId, Pending>();
  private failure?: Error;
  private readonly failed = Promise.withResolvers<never>();
  readonly failureSignal = this.failed.promise;

  constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    private readonly clock: Clock,
    private readonly notification: (method: string, params: unknown) => void,
    private readonly requestHandler: (
      method: string,
      params: unknown,
    ) => Promise<unknown>,
  ) {
    void this.failureSignal.catch(() => {});
    child.stdin.on('error', () =>
      this.fail(new AcpError('ACP input pipe failed')),
    );
    child.once('error', () =>
      this.fail(new AcpError('ACP process could not start')),
    );
    child.once('exit', () => this.fail(new AcpError('ACP process exited')));
    void this.read().catch((error) =>
      this.fail(
        error instanceof AcpError
          ? error
          : new AcpError('Invalid or oversized ACP protocol message'),
      ),
    );
  }

  private async read(): Promise<void> {
    const decoder = new StringDecoder('utf8');
    let pending = '';
    for await (const chunk of this.child.stdout) {
      pending += decoder.write(chunk as Buffer);
      let newline: number;
      while ((newline = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        if (Buffer.byteLength(line) > 1024 * 1024)
          throw new AcpError('ACP message limit exceeded');
        if (line.trim()) this.receive(JSON.parse(line));
      }
      if (Buffer.byteLength(pending) > 1024 * 1024)
        throw new AcpError('ACP message limit exceeded');
    }
    if ((pending + decoder.end()).trim())
      throw new AcpError('Incomplete ACP protocol message');
    this.fail(new AcpError('ACP output closed'));
  }

  private receive(raw: unknown): void {
    const message = MessageSchema.parse(raw);
    if (message.method !== undefined) {
      if (message.result !== undefined || message.error !== undefined)
        throw new AcpError('Invalid ACP request envelope');
      if (message.id === undefined)
        this.notification(message.method, message.params);
      else {
        const id = message.id;
        void this.requestHandler(message.method, message.params)
          .then(
            (result) => this.write({ jsonrpc: '2.0', id, result }),
            (error) => {
              const unsupported =
                error instanceof AcpError && error.rpcCode === -32601;
              this.write({
                jsonrpc: '2.0',
                id,
                error: {
                  code: unsupported ? -32601 : -32603,
                  message: unsupported
                    ? 'Method not found'
                    : 'Client rejected invalid request',
                },
              });
              if (!unsupported)
                this.fail(new AcpError('Invalid ACP client request'));
            },
          )
          .catch(() => this.fail(new AcpError('ACP response failed')));
      }
      return;
    }
    if (message.id === undefined || 'result' in message === 'error' in message)
      throw new AcpError('Invalid ACP response envelope');
    const request = this.pending.get(message.id);
    if (!request) throw new AcpError('Unmatched ACP response');
    this.pending.delete(message.id);
    this.clock.clearTimeout(request.timer);
    if (message.error)
      request.reject(new AcpError(message.error.message, message.error.code));
    else request.resolve(message.result);
  }

  private write(message: unknown): void {
    if (this.failure) throw this.failure;
    this.child.stdin.write(JSON.stringify(message) + '\n');
    if (this.child.stdin.writableLength > 1024 * 1024)
      this.fail(new AcpError('ACP input backpressure limit exceeded'));
  }

  request<T>(
    method: string,
    params: unknown,
    schema: z.ZodType<T>,
    timeoutMs = 60_000,
  ): Promise<T> {
    if (this.failure) return Promise.reject(this.failure);
    const id = ++this.serial;
    const { promise, resolve, reject } = Promise.withResolvers<unknown>();
    const timer = this.clock.setTimeout(() => {
      this.pending.delete(id);
      const error = new AcpError(`ACP ${method} deadline exceeded`);
      reject(error);
      this.fail(error);
    }, timeoutMs);
    this.pending.set(id, { resolve, reject, timer });
    try {
      this.write({ jsonrpc: '2.0', id, method, params });
    } catch {
      this.fail(new AcpError('ACP request could not be sent'));
    }
    return promise.then((value) => {
      const parsed = schema.safeParse(value);
      if (!parsed.success) {
        const error = new AcpError(`Invalid ACP ${method} response`);
        this.fail(error);
        throw error;
      }
      return parsed.data;
    });
  }

  notify(method: string, params: unknown): void {
    this.write({ jsonrpc: '2.0', method, params });
  }

  fail(error: Error): void {
    if (this.failure) return;
    this.failure = error;
    for (const pending of this.pending.values()) {
      this.clock.clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    this.failed.reject(error);
  }
}
