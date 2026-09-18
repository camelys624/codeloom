import { performance } from 'node:perf_hooks';
import { parseUnifiedDiff } from '../apps/web/client/src/lib/diff.js';

const fileCount = 50;
const linesPerFile = 60;
const patch = Array.from({ length: fileCount }, (_, fileIndex) => {
  const lines = Array.from(
    { length: linesPerFile },
    (_, lineIndex) =>
      `+export const value_${fileIndex}_${lineIndex} = ${lineIndex};`,
  ).join('\n');
  return `diff --git a/src/file-${fileIndex}.ts b/src/file-${fileIndex}.ts\n--- a/src/file-${fileIndex}.ts\n+++ b/src/file-${fileIndex}.ts\n@@ -1,0 +1,${linesPerFile} @@\n${lines}\n`;
}).join('');

const started = performance.now();
const parsed = parseUnifiedDiff(patch);
const elapsedMs = performance.now() - started;
const result = {
  fileCount: parsed.files.length,
  additions: parsed.additions,
  patchBytes: Buffer.byteLength(patch),
  elapsedMs: Number(elapsedMs.toFixed(2)),
  passed: parsed.files.length === fileCount && elapsedMs < 1000,
};
console.log(JSON.stringify(result, null, 2));
if (!result.passed) process.exitCode = 1;
