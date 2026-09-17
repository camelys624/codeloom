import { StringDecoder } from 'node:string_decoder';
import { z } from 'zod';
import {
  MAX_FRAME_STRING_BYTES,
  type AgentEngine,
} from '@agent-workspace/contracts';
const COMMON_ENV = [
  'PATH',
  'HOME',
  'LANG',
  'TERM',
  'http_proxy',
  'https_proxy',
  'all_proxy',
  'no_proxy',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'NO_PROXY',
] as const;

/** Variables each engine may receive from the Runner, beyond the common set.
 * Only `claude-code` has a shipped adapter; the `codex` and `pi` lists are provisional and
 * must be confirmed against the engine's documentation when its adapter is written.
 * `custom` receives the common set only: an arbitrary ACP binary declares nothing.
 */
export const ENGINE_ENV_ALLOWLIST: Readonly<
  Record<AgentEngine, readonly string[]>
> = {
  'claude-code': [
    ...COMMON_ENV,
    'CLAUDE_CONFIG_DIR',
    'CLAUDE_CODE_OAUTH_TOKEN',
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_AUTH_TOKEN',
    'ANTHROPIC_BASE_URL',
    'ANTHROPIC_MODEL',
    'ANTHROPIC_DEFAULT_HAIKU_MODEL',
    'ANTHROPIC_DEFAULT_SONNET_MODEL',
    'ANTHROPIC_DEFAULT_OPUS_MODEL',
    'ANTHROPIC_DEFAULT_FABLE_MODEL',
    'ANTHROPIC_DEFAULT_FABLE_MODEL_NAME',
    'ANTHROPIC_DEFAULT_MODEL',
  ],
  codex: [...COMMON_ENV, 'CODEX_HOME', 'OPENAI_API_KEY', 'OPENAI_BASE_URL'],
  pi: [
    ...COMMON_ENV,
    'PI_CODING_AGENT_DIR',
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_BASE_URL',
    'OPENAI_API_KEY',
    'OPENAI_BASE_URL',
    'GEMINI_API_KEY',
    'OPENROUTER_API_KEY',
  ],
  custom: [...COMMON_ENV],
};

export function engineEnvironment(
  engine: AgentEngine,
  source: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const name of ENGINE_ENV_ALLOWLIST[engine]) {
    const value = source[name];
    if (value !== undefined) result[name] = value;
  }
  return result;
}

const SECRET_NAME = /(?:authorization|cookie|(?:^|_)(?:token|key|secret)$)/i;
const MAX_STRING = MAX_FRAME_STRING_BYTES;
export const MAX_FRAME_TEXT_BYTES = MAX_STRING;
const JsonSchema = z.json();

export function truncateUtf8(
  text: string,
  maxBytes = MAX_FRAME_TEXT_BYTES,
  marker = '[TRUNCATED]',
): { text: string; truncated: boolean } {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes)
    return { text, truncated: false };
  const markerBytes = Buffer.byteLength(marker, 'utf8');
  const prefix = Buffer.from(text).subarray(0, maxBytes - markerBytes);
  return {
    text: new StringDecoder('utf8').write(prefix) + marker,
    truncated: true,
  };
}
function boundedText(text: string): string {
  return truncateUtf8(text).text;
}

export class Redactor {
  private readonly secrets: string[];

  constructor(env: Readonly<Record<string, string | undefined>>) {
    this.secrets = Object.entries(env)
      .filter(
        ([name, value]) =>
          value && (SECRET_NAME.test(name) || /_PROXY$/i.test(name)),
      )
      .map(([, value]) => value!)
      .sort((a, b) => b.length - a.length);
  }

  text(input: string): string {
    let text = input;
    for (const secret of this.secrets)
      text = text.replaceAll(secret, '[REDACTED]');
    return text
      .replace(
        /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
        '[REDACTED PRIVATE KEY]',
      )
      .replace(
        /((?:Authorization|Cookie|Set-Cookie)\s*["']?\s*[:=]\s*)[^\r\n]*/gi,
        '$1[REDACTED]',
      )
      .replace(
        /((?:[A-Z0-9_]+_(?:TOKEN|KEY|SECRET))\s*["']?\s*[:=]\s*)[^\r\n]*/gi,
        '$1[REDACTED]',
      )
      .replace(/\b(?:sk-ant-[\w-]+|sk-[A-Za-z0-9_-]{20,})\b/g, '[REDACTED]')
      .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/g, '$1[REDACTED]@');
  }

  json(input: unknown): z.infer<typeof JsonSchema> {
    let bytes = 0;
    const visit = (
      value: unknown,
      depth: number,
    ): z.infer<typeof JsonSchema> => {
      if (depth > 16 || bytes > 64 * 1024) return '[TRUNCATED]';
      if (typeof value === 'string') {
        bytes += Buffer.byteLength(value, 'utf8');
        const clean = this.text(value);
        return boundedText(clean);
      }
      if (value === null || typeof value === 'boolean') return value;
      if (typeof value === 'number')
        return Number.isFinite(value) ? value : null;
      if (Array.isArray(value))
        return value.slice(0, 256).map((item) => visit(item, depth + 1));
      if (typeof value === 'object') {
        const result: Record<
          string,
          z.infer<typeof JsonSchema>
        > = Object.create(null) as Record<string, z.infer<typeof JsonSchema>>;
        for (const [key, item] of Object.entries(value).slice(0, 256)) {
          bytes += Buffer.byteLength(key, 'utf8');
          result[this.text(key).slice(0, 256)] = SECRET_NAME.test(key)
            ? '[REDACTED]'
            : visit(item, depth + 1);
        }
        return result;
      }
      return null;
    };
    return visit(input, 0);
  }
}

/** Only complete lines leave the buffer: labels and secret values may straddle ACP chunks.
 * Oversized lines are withheld entirely rather than releasing an unsafe prefix.
 */
export class RedactedLines {
  private pending = '';
  private dropping = false;
  private privateKey = false;

  constructor(
    private readonly redactor: Redactor,
    private readonly emit: (text: string, truncated: boolean) => void,
  ) {}

  push(chunk: string): void {
    for (const part of chunk.match(/[^\n]*\n|[^\n]+$/g) ?? []) {
      if (!this.dropping) {
        this.pending += part;
        if (Buffer.byteLength(this.pending, 'utf8') > MAX_STRING) {
          this.privateKey ||= /-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(
            this.pending,
          );
          this.pending = '';
          this.dropping = true;
        }
      }
      if (part.endsWith('\n')) this.flushLine();
    }
  }

  finish(): void {
    if (this.pending || this.dropping) this.flushLine();
  }

  private flushLine(): void {
    if (this.dropping) this.emit('[TRUNCATED]\n', true);
    else {
      const startsKey = /-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(this.pending);
      const endsKey = /-----END [A-Z ]*PRIVATE KEY-----/.test(this.pending);
      if (this.privateKey || startsKey) {
        if (!this.privateKey) this.emit('[REDACTED PRIVATE KEY]\n', false);
        this.privateKey = !endsKey;
      } else this.emit(this.redactor.text(this.pending), false);
    }
    this.pending = '';
    this.dropping = false;
  }
}
