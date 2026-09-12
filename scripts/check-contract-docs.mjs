import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

// Compile the documented public types against both sides of the Zod-inferred
// contract. This catches missing fields, enum drift and optionality changes.
const root = fileURLToPath(new URL('../', import.meta.url));
const documents = ['docs/domain-model.md', 'docs/runner-agent-protocol.md'];
const blocks = [];
const names = new Set();
for (const document of documents) {
  const markdown = await readFile(
    new URL(`../${document}`, import.meta.url),
    'utf8',
  );
  for (const match of markdown.matchAll(/```ts\s*\n([\s\S]*?)```/g)) {
    const text = match[1];
    const source = ts.createSourceFile(
      document + '.ts',
      text,
      ts.ScriptTarget.Latest,
    );
    const declarations = source.statements.filter(
      (statement) =>
        ts.isTypeAliasDeclaration(statement) ||
        ts.isInterfaceDeclaration(statement),
    );
    if (declarations.length === 0) continue;
    blocks.push(text);
    for (const declaration of declarations) names.add(declaration.name.text);
  }
}
if (names.size === 0) throw new Error('No documented contracts found');
const fileName = root + 'scripts/__contract_documentation_check__.ts';
const content = [
  "import type * as Contract from '../packages/contracts/src/index.js';",
  'namespace Documented {',
  'type Clock = Contract.Clock;',
  'type TranscriptFrame = Contract.TranscriptFrame;',
  ...blocks,
  ...Array.from(names, (name) => `export type Mirror_${name} = ${name};`),
  '}',
  'type Assert<T extends true> = T;',
  ...Array.from(
    names,
    (name) =>
      `type Check_${name} = Assert<[Documented.Mirror_${name}] extends [Contract.${name}] ? [Contract.${name}] extends [Documented.Mirror_${name}] ? true : false : false>;`,
  ),
].join('\n');
const options = {
  target: ts.ScriptTarget.ES2023,
  module: ts.ModuleKind.NodeNext,
  moduleResolution: ts.ModuleResolutionKind.NodeNext,
  strict: true,
  skipLibCheck: true,
  noEmit: true,
};
const host = ts.createCompilerHost(options);
const read = host.readFile.bind(host);
const exists = host.fileExists.bind(host);
host.readFile = (path) => (path === fileName ? content : read(path));
host.fileExists = (path) => path === fileName || exists(path);
const program = ts.createProgram([fileName], options, host);
const diagnostics = ts.getPreEmitDiagnostics(program);
if (diagnostics.length) {
  console.error(
    ts.formatDiagnosticsWithColorAndContext(diagnostics, {
      getCanonicalFileName: (file) => file,
      getCurrentDirectory: () => root,
      getNewLine: () => '\n',
    }),
  );
  process.exitCode = 1;
} else {
  console.log(`${names.size} documented types match their exported contracts`);
}
