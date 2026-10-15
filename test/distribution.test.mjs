import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { checkDistribution, credentialMarkers, publicFiles } from "../scripts/check-distribution.mjs";

test("the shipped template has every allowlisted file and no detected credential markers", async () => {
  const root = fileURLToPath(new URL("../", import.meta.url));
  assert.deepEqual(await checkDistribution(root), []);
});

test("the distribution guard rejects a private key and an unexpected file without printing contents", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "review-gate-test-"));
  try {
    for (const file of publicFiles) {
      await mkdir(path.dirname(path.join(root, file)), { recursive: true });
      await writeFile(path.join(root, file), "fixture\n");
    }
    const marker = ["-----BEGIN", "RSA PRIVATE KEY-----"].join(" ");
    await writeFile(path.join(root, "extra.pem"), marker);
    const errors = await checkDistribution(root);
    assert.ok(errors.some((error) => error.includes("Unexpected files: extra.pem")));
    assert.ok(errors.some((error) => error.includes("Potential credential")));
    assert.ok(errors.every((error) => !error.includes(marker)));
    assert.equal(credentialMarkers("ghp_" + "a".repeat(36)), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the public repo activates only read-only CI; privileged workflows ship as templates", async () => {
  const ci = await readFile(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
  assert.doesNotMatch(ci, /pull_request_target|secrets\.|statuses: write/);
  const publisher = await readFile(new URL("../template/.github/workflows/codex-review-gate.yml", import.meta.url), "utf8");
  assert.match(publisher, /environment: codex-review-gate/);
  assert.match(publisher, /ref: \$\{\{ github.event.repository.default_branch \}\}/);
  assert.match(publisher, /permission-statuses: write/);
  assert.match(publisher, /statuses: read/);
  assert.doesNotMatch(publisher, /pull_request\.head|persist-credentials: true/);
});
