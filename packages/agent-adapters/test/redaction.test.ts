import { describe, expect, it } from 'vitest';
import { FrameTextSchema } from '@agent-workspace/contracts';
import {
  RedactedLines,
  Redactor,
  engineEnvironment,
  truncateUtf8,
} from '../src/redaction.js';

describe('Agent output security boundary', () => {
  it('redacts credentials whose labels and values span chunks', () => {
    const emitted: string[] = [];
    const stream = new RedactedLines(
      new Redactor({ ANTHROPIC_AUTH_TOKEN: 'secret-provider-value' }),
      (text) => emitted.push(text),
    );
    stream.push('Auth');
    stream.push('orization: Bearer secret-');
    stream.push('provider-value\nSafe output\n');
    stream.finish();
    expect(emitted.join('')).toBe('Authorization: [REDACTED]\nSafe output\n');
  });

  it('withholds all lines inside a private key block', () => {
    const emitted: string[] = [];
    const stream = new RedactedLines(new Redactor({}), (text) =>
      emitted.push(text),
    );
    stream.push('-----BEGIN PRIVATE');
    stream.push(' KEY-----\nprivate-part-one\nprivate-part-two\n');
    stream.push('-----END PRIVATE KEY-----\nVisible again\n');
    expect(emitted.join('')).toBe('[REDACTED PRIVATE KEY]\nVisible again\n');
  });

  it('emits only valid UTF-8-sized frames for non-ASCII output', () => {
    const emitted: string[] = [];
    const stream = new RedactedLines(new Redactor({}), (text) =>
      emitted.push(text),
    );
    stream.push('汉'.repeat(16_000) + '\n');
    stream.finish();
    expect(
      emitted.every((text) => FrameTextSchema.safeParse(text).success),
    ).toBe(true);
    expect(emitted.join('')).toContain('[TRUNCATED]');
    expect(
      FrameTextSchema.safeParse(new Redactor({}).json('汉'.repeat(16_000)))
        .success,
    ).toBe(true);
  });

  it('truncates multibyte frame text within the byte limit', () => {
    const result = truncateUtf8('汉'.repeat(16_000));
    expect(result.truncated).toBe(true);
    expect(Buffer.byteLength(result.text, 'utf8')).toBeLessThanOrEqual(
      32 * 1024,
    );
    expect(FrameTextSchema.safeParse(result.text).success).toBe(true);
    expect(result.text.endsWith('[TRUNCATED]')).toBe(true);
  });

  it('forwards only declared engine variables, never runner credentials or process injection', () => {
    const source = {
      PATH: '/bin',
      HOME: '/home/example',
      ANTHROPIC_AUTH_TOKEN: 'provider',
      ANTHROPIC_BASE_URL: 'https://provider.example',
      ANTHROPIC_DEFAULT_FABLE_MODEL: 'claude-fable-5-1[1M]',
      ANTHROPIC_DEFAULT_FABLE_MODEL_NAME: 'claude-fable-5-1[1M]',
      OPENAI_API_KEY: 'openai-secret',
      https_proxy: 'http://proxy.example:8080',
      RUNNER_TOKEN: 'runner-secret',
      NODE_OPTIONS: '--require=malicious.cjs',
    };
    expect(engineEnvironment('claude-code', source)).toEqual({
      PATH: '/bin',
      HOME: '/home/example',
      ANTHROPIC_AUTH_TOKEN: 'provider',
      ANTHROPIC_BASE_URL: 'https://provider.example',
      ANTHROPIC_DEFAULT_FABLE_MODEL: 'claude-fable-5-1[1M]',
      ANTHROPIC_DEFAULT_FABLE_MODEL_NAME: 'claude-fable-5-1[1M]',
      https_proxy: 'http://proxy.example:8080',
    });
    expect(engineEnvironment('codex', source)).toEqual({
      PATH: '/bin',
      HOME: '/home/example',
      OPENAI_API_KEY: 'openai-secret',
      https_proxy: 'http://proxy.example:8080',
    });
    expect(engineEnvironment('custom', source)).toEqual({
      PATH: '/bin',
      HOME: '/home/example',
      https_proxy: 'http://proxy.example:8080',
    });
  });
});
