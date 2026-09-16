import { highlightDiffLine, parseUnifiedDiff } from '../src/lib/diff.js';
import { describe, expect, it } from 'vitest';

const patch = `diff --git a/src/app.ts b/src/app.ts
index 1111111..2222222 100644
--- a/src/app.ts
+++ b/src/app.ts
@@ -1,3 +1,4 @@
 const before = true;
-oldCall();
+newCall('value');
+return true;
`;

describe('unified diff parsing', () => {
  it('builds a file tree with line numbers and aggregate stats', () => {
    const result = parseUnifiedDiff(patch);
    expect(result).toMatchObject({
      additions: 2,
      deletions: 1,
      isBinary: false,
    });
    expect(result.files).toHaveLength(1);
    expect(result.files[0]).toMatchObject({
      path: 'src/app.ts',
      status: 'modified',
      additions: 2,
      deletions: 1,
    });
    expect(result.files[0]?.hunks[0]?.lines).toEqual([
      { kind: 'context', text: 'const before = true;', oldLine: 1, newLine: 1 },
      { kind: 'deletion', text: 'oldCall();', oldLine: 2 },
      { kind: 'addition', text: "newCall('value');", newLine: 2 },
      { kind: 'addition', text: 'return true;', newLine: 3 },
    ]);
  });

  it('marks binary and renamed files without manufacturing code lines', () => {
    const result = parseUnifiedDiff(
      'diff --git a/old.bin b/new.bin\nsimilarity index 100%\nrename from old.bin\nrename to new.bin\nBinary files a/old.bin and b/new.bin differ\n',
    );
    expect(result.files[0]).toMatchObject({
      path: 'new.bin',
      oldPath: 'old.bin',
      newPath: 'new.bin',
      status: 'binary',
      lineCount: 0,
    });
    expect(result.isBinary).toBe(true);
  });
});

describe('diff token highlighting', () => {
  it('classifies keywords, strings, numbers and comments for code files', () => {
    expect(
      highlightDiffLine("const value = 'ok'; // note", 'src/app.ts'),
    ).toEqual([
      { kind: 'keyword', text: 'const' },
      { kind: 'plain', text: ' ' },
      { kind: 'plain', text: 'value' },
      { kind: 'plain', text: ' ' },
      { kind: 'operator', text: '=' },
      { kind: 'plain', text: ' ' },
      { kind: 'string', text: "'ok'" },
      { kind: 'operator', text: ';' },
      { kind: 'plain', text: ' ' },
      { kind: 'comment', text: '// note' },
    ]);
    expect(highlightDiffLine('plain text', 'README.txt')).toEqual([
      { kind: 'plain', text: 'plain text' },
    ]);
  });
});
describe('diff parser limits', () => {
  it('does not manufacture files from unrelated patch preamble', () => {
    expect(parseUnifiedDiff('warning\n--- not-a-file\n').files).toEqual([]);
  });

  it('preserves a no-newline marker as metadata inside a hunk', () => {
    const result = parseUnifiedDiff(
      'diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-old\n+new\n\\ No newline at end of file\n',
    );
    expect(result.files[0]?.hunks[0]?.lines.at(-1)).toEqual({
      kind: 'meta',
      text: '\\ No newline at end of file',
    });
  });
});
