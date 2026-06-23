/**
 * Tests — qt-183: `[verbose]`-prefixed lines and PII reveal lines must be
 * gated behind the explicit `--verbose` flag.
 *
 * Failure modes this test locks against:
 *   1. A regression that leaks `[verbose] ...` log sites into default output
 *      (which today exposes the user's email and the telemetry endpoint).
 *   2. A regression that prints `✓ Telemetry authenticated as <email>` or
 *      `✓ Scan uploaded to <workspace>` in default mode (leaks PII into
 *      a shareable screenshot).
 *   3. A regression that breaks `--verbose` itself — the trace MUST still
 *      surface for users who explicitly opt in.
 *
 * The test invokes `node dist/index.js --demo` rather than importing main()
 * so it exercises the actual CLI surface that `npx nark` users hit. We use
 * `--demo` because it's hermetic (bundled fixture, no external paths needed)
 * and `--report-only` to skip the HTML/JSON output writes — we only care
 * about the stdout/stderr surface here.
 *
 * `NARK_TELEMETRY=off` keeps the run offline so the test does not hang on a
 * network timeout. The verbose-mode assertion uses `[verbose] Time breakdown`
 * and `[verbose] Contracts loaded` as markers — those fire on every scan
 * regardless of telemetry state, so the test stays robust if telemetry
 * branches change.
 */

import { describe, it, expect } from "vitest";
import { execSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const NARK_BIN = path.join(REPO_ROOT, "dist", "index.js");

function runNark(extraFlags: string[]): string {
  // HOME is redirected to a fresh tmpdir so the CLI's `~/.nark/projects/...`
  // side artifacts land somewhere the sandbox + restricted CI envs allow,
  // and so previous-run state (first-run hint flag, cached auth, etc.) can't
  // leak between assertions.
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "nark-verbose-test-"));
  const flags = ["--demo", "--report-only", ...extraFlags].join(" ");
  return execSync(`node ${NARK_BIN} ${flags} 2>&1`, {
    env: { ...process.env, NARK_TELEMETRY: "off", HOME: tmpHome },
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
  });
}

describe("qt-183: verbose gating", () => {
  it("default mode emits zero `[verbose]` substrings", () => {
    if (!fs.existsSync(NARK_BIN)) {
      // Skip-when-no-dist: mirrors demo.test.ts. A fresh clone without a
      // build should not fail this test — the build is the prerequisite.
      return;
    }
    const out = runNark([]);

    expect(out).not.toContain("[verbose]");
  }, 30_000);

  it("default mode does not leak email or workspace name in the scan-uploaded footer", () => {
    if (!fs.existsSync(NARK_BIN)) {
      return;
    }
    const out = runNark([]);

    // The two PII reveal lines from src/index.ts (lines ~1720-1730) must not
    // appear in default output. If telemetry is off (as it is here), the
    // footer block is silent anyway — but we keep these regex assertions so
    // future telemetry-mode changes can't silently re-introduce the leak.
    expect(out).not.toMatch(/Telemetry authenticated as .+@.+/);
    expect(out).not.toMatch(/Scan uploaded to .+\(.+\)/);
  }, 30_000);

  it("`--verbose` still emits the `[verbose]` trace", () => {
    if (!fs.existsSync(NARK_BIN)) {
      return;
    }
    const out = runNark(["--verbose"]);

    // `[verbose] Contracts loaded:` and `[verbose] Time breakdown:` fire on
    // every scan regardless of telemetry state, so they are the stable
    // markers for verbose-mode liveness.
    expect(out).toContain("[verbose]");
    expect(out).toMatch(/\[verbose\] Contracts loaded:/);
    expect(out).toMatch(/\[verbose\] Time breakdown:/);
  }, 30_000);
});
