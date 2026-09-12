import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

assert.equal(
  process.versions.node.split('.')[0],
  '22',
  'Production runtime must be Node.js 22',
);
const require = createRequire(import.meta.url);
const argon2 = require('argon2');
const hash = await argon2.hash('native-module-smoke', {
  type: argon2.argon2id,
});
assert.ok(await argon2.verify(hash, 'native-module-smoke'));
assert.equal(await argon2.verify(hash, 'wrong-password'), false);
console.log(
  'Node.js 22: argon2id hash, successful verification and password rejection passed',
);
