import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const script = fileURLToPath(new URL("./codeloom-init.mjs", import.meta.url));

test("custom output creates private credentials without replacing existing files or symlink targets", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "codeloom-init-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const output = join(dir, "team.env");
  const run = (target) => spawnSync(process.execPath, [
    script, "--origin", "http://multica.internal:3100",
    "--bind-address", "192.168.1.20", "--email", "team@example.invalid",
    "--output", target,
  ], { cwd: dir, encoding: "utf8" });

  const created = run(output);
  assert.equal(created.status, 0, created.stderr);
  const original = readFileSync(output, "utf8");
  if (process.platform !== "win32") {
    assert.equal(statSync(output).mode & 0o777, 0o600);
  }
  assert.equal(run(output).status, 1);
  assert.equal(readFileSync(output, "utf8"), original);
  if (process.platform !== "win32") {
    const link = join(dir, "linked.env");
    symlinkSync(output, link);
    assert.equal(run(link).status, 1);
    assert.equal(readFileSync(output, "utf8"), original);
  }
});
