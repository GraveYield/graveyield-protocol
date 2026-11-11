import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const DRIVER = join(HERE, "..", "lifecycle_rehearsal", "drive_lifecycle.mjs");

const source = readFileSync(DRIVER, "utf8");
const start = source.indexOf("// --- [stage 16]");
const end = source.indexOf("// --- finish", start);

test("Stage 16 passes explicit local-validator opt-in to both emergency drills", () => {
  assert.notEqual(start, -1, "Stage 16 marker must exist");
  assert.notEqual(end, -1, "lifecycle finish marker must exist");

  const stage16 = source.slice(start, end);

  assert.match(
    stage16,
    /for\s*\(const program of \["scanner", "vault"\]\)/,
    "both scanner and vault drills must remain covered",
  );

  assert.match(
    stage16,
    /adminScript,\s*"drill",\s*"--allow-local-validator",\s*"--url",\s*url/,
    "the drill invocation must explicitly enable the loopback-only local mode",
  );
});
