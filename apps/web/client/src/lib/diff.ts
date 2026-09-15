const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?: (.*))?$/;

export type DiffLineKind = 'context' | 'addition' | 'deletion' | 'meta';

export type DiffLine = {
  kind: DiffLineKind;
  text: string;
  oldLine?: number;
  newLine?: number;
};

export type DiffHunk = {
  header: string;
  oldStart: number;
  newStart: number;
  lines: DiffLine[];
};

export type DiffFile = {
  path: string;
  oldPath?: string;
  newPath?: string;
  status: 'modified' | 'added' | 'deleted' | 'renamed' | 'binary';
  additions: number;
  deletions: number;
  hunks: DiffHunk[];
  lineCount: number;
};

export type ParsedDiff = {
  files: DiffFile[];
  additions: number;
  deletions: number;
  isBinary: boolean;
};

function unquotePath(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      return JSON.parse(trimmed) as string;
    } catch {
      return trimmed.slice(1, -1);
    }
  }
  return trimmed;
}

function diffPath(value: string): string {
  const path = unquotePath(value);
  return path.startsWith('a/') || path.startsWith('b/') ? path.slice(2) : path;
}

function splitHeaderPath(line: string): string {
  const value = line.slice(4).trim();
  const tab = value.indexOf('\t');
  return tab >= 0 ? value.slice(0, tab) : (value.split(/\s+/, 1)[0] ?? value);
}

function newFile(path: string): DiffFile {
  return {
    path,
    status: 'modified',
    additions: 0,
    deletions: 0,
    hunks: [],
    lineCount: 0,
  };
}

export function parseUnifiedDiff(patch: string): ParsedDiff {
  const files: DiffFile[] = [];
  let current: DiffFile | undefined;
  let hunk: DiffHunk | undefined;
  let oldLine = 0;
  let newLine = 0;
  let binary = false;

  const finishHunk = () => {
    if (current && hunk) current.hunks.push(hunk);
    hunk = undefined;
  };
  const finishFile = () => {
    finishHunk();
    if (current) {
      current.lineCount = current.hunks.reduce(
        (count, item) => count + item.lines.length,
        0,
      );
      files.push(current);
    }
    current = undefined;
  };

  for (const line of patch.split(/\r?\n/)) {
    if (line.startsWith('diff --git ')) {
      finishFile();
      const match = /^diff --git (.+?) (.+)$/.exec(line);
      const oldPath = match?.[1];
      const newPath = match?.[2];
      const path = newPath ? diffPath(newPath) : 'unknown';
      current = newFile(path);
      current.oldPath = oldPath ? diffPath(oldPath) : path;
      current.newPath = path;
      continue;
    }
    if (!current) continue;
    if (line.startsWith('new file mode ')) {
      current.status = 'added';
      continue;
    }
    if (line.startsWith('deleted file mode ')) {
      current.status = 'deleted';
      continue;
    }
    if (line.startsWith('similarity index ') || line.startsWith('rename ')) {
      current.status = 'renamed';
      continue;
    }
    if (line.startsWith('Binary files ') || line === 'GIT binary patch') {
      current.status = 'binary';
      binary = true;
      continue;
    }
    if (line.startsWith('--- ')) {
      const path = splitHeaderPath(line);
      current.oldPath = path === '/dev/null' ? undefined : diffPath(path);
      continue;
    }
    if (line.startsWith('+++ ')) {
      const path = splitHeaderPath(line);
      current.newPath = path === '/dev/null' ? undefined : diffPath(path);
      current.path = current.newPath ?? current.oldPath ?? current.path;
      continue;
    }
    const header = HUNK_HEADER.exec(line);
    if (header) {
      finishHunk();
      oldLine = Number(header[1]);
      newLine = Number(header[3]);
      hunk = {
        header: line,
        oldStart: oldLine,
        newStart: newLine,
        lines: [],
      };
      continue;
    }
    if (!hunk) continue;
    if (line.startsWith('+') && !line.startsWith('+++')) {
      hunk.lines.push({ kind: 'addition', text: line.slice(1), newLine });
      current.additions += 1;
      newLine += 1;
    } else if (line.startsWith('-') && !line.startsWith('---')) {
      hunk.lines.push({ kind: 'deletion', text: line.slice(1), oldLine });
      current.deletions += 1;
      oldLine += 1;
    } else if (line.startsWith(' ')) {
      hunk.lines.push({
        kind: 'context',
        text: line.slice(1),
        oldLine,
        newLine,
      });
      oldLine += 1;
      newLine += 1;
    } else if (line.startsWith('\\')) {
      hunk.lines.push({ kind: 'meta', text: line });
    }
  }
  finishFile();

  return {
    files,
    additions: files.reduce((sum, file) => sum + file.additions, 0),
    deletions: files.reduce((sum, file) => sum + file.deletions, 0),
    isBinary: binary,
  };
}

export type HighlightToken = { kind: string; text: string };

const KEYWORDS =
  /^(?:as|async|await|break|case|catch|class|const|continue|def|else|export|extends|finally|for|from|function|if|import|in|interface|let|new|of|private|protected|public|return|static|switch|throw|try|type|var|while|with|yield)$/;
const TOKEN =
  /\/\/[^\n]*|#[^\n]*|\/\*[\s\S]*?\*\/|'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|`(?:\\.|[^`\\])*`|\b\d+(?:\.\d+)?\b|[A-Za-z_$][\w$]*|===|!==|=>|==|!=|<=|>=|&&|\|\||[{}()[\].,:;<>+*/%=&|!?-]/g;

export function highlightDiffLine(
  text: string,
  path: string,
): HighlightToken[] {
  const extension = path.split('.').at(-1)?.toLocaleLowerCase();
  const codeLike = new Set([
    'c',
    'cc',
    'cpp',
    'css',
    'go',
    'h',
    'hpp',
    'html',
    'java',
    'js',
    'json',
    'jsx',
    'md',
    'py',
    'rs',
    'sh',
    'sql',
    'ts',
    'tsx',
    'xml',
    'yaml',
    'yml',
  ]);
  if (!extension || !codeLike.has(extension)) return [{ kind: 'plain', text }];
  const tokens: HighlightToken[] = [];
  let cursor = 0;
  for (const match of text.matchAll(TOKEN)) {
    const index = match.index ?? cursor;
    if (index > cursor)
      tokens.push({ kind: 'plain', text: text.slice(cursor, index) });
    const value = match[0];
    let kind = 'plain';
    if (
      value.startsWith('//') ||
      value.startsWith('#') ||
      value.startsWith('/*')
    )
      kind = 'comment';
    else if (/^[`'\"]/.test(value)) kind = 'string';
    else if (/^\d/.test(value)) kind = 'number';
    else if (KEYWORDS.test(value)) kind = 'keyword';
    else if (
      /^(?:===|!==|=>|==|!=|<=|>=|&&|\|\||[{}()[\].,:;<>+*/%=&|!?-])$/.test(
        value,
      )
    )
      kind = 'operator';
    tokens.push({ kind, text: value });
    cursor = index + value.length;
  }
  if (cursor < text.length)
    tokens.push({ kind: 'plain', text: text.slice(cursor) });
  return tokens;
}
