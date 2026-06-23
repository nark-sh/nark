/**
 * Tests — qt-188: gate the `AI fix: nark --instructions-path` hint at
 * src/index.ts:~2109 so it prints ONCE on the first violation-bearing
 * default-mode scan on a given HOME, then is suppressed forever (a flag
 * `aiHintShown=true` is persisted to `~/.nark/telemetry.json`).
 *
 * Two distinct hint lines live in src/index.ts and BOTH carry the
 * `nark --instructions-path` string. They appear in DIFFERENT scan modes:
 *
 *   Line 1456 — `For AI agent instructions: nark --instructions-path`
 *   Lives inside the `if (verbose && options.terminal !== false)` block
 *   (the 5-path `Reports written to:` block). qt-185 already moved it
 *   behind `--verbose`; default mode does NOT print it. Test 1 below
 *   regressively locks that closure.
 *
 *   Line 2109 — `AI fix:      nark --instructions-path`
 *   Lives inside `printCompactReport()` (the default-mode renderer).
 *   PRE-fix, prints on every default-mode scan that has violations.
 *   POST-fix, prints once then is suppressed. Test 2 below locks that.
 *
 * Test 3 covers the `--verbose` behavior: line 1456 always prints under
 * --verbose (preserved by qt-185), and line 2109 is irrelevant under
 * --verbose because that branch uses the full-report renderer, not
 * printCompactReport. The qt-188 gate must NOT pollute the persisted
 * `aiHintShown` flag when running under --verbose, so a subsequent
 * default-mode user on the same HOME still sees the hint exactly once.
 *
 * Mirrors the test scaffolding established by qt-183/184/185/186/187:
 * - `node dist/index.js --demo --report-only` with `NARK_TELEMETRY=off`
 *   + `mkdtempSync` HOME for state isolation
 * - ANSI strip helper copied from src/path-consolidation.test.ts
 * - qt-186-style throw-not-silent-skip guard so contributors get a clear
 *   remediation message instead of a falsely-green suite
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

// Strip ANSI escape sequences so assertions can match plain text content.
function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

function runNark(
  extraFlags: string[],
  tmpHome: string,
): { stdout: string; home: string } {
  const flags = ["--demo", "--report-only", ...extraFlags].join(" ");
  const stdout = execSync(`node ${NARK_BIN} ${flags} 2>&1`, {
    env: { ...process.env, NARK_TELEMETRY: "off", HOME: tmpHome },
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
  });
  return { stdout, home: tmpHome };
}

function freshHome(label: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `nark-ai-hint-${label}-`));
}

function readTelemetryConfig(home: string): Record<string, unknown> | null {
  const cfgPath = path.join(home, ".nark", "telemetry.json");
  if (!fs.existsSync(cfgPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(cfgPath, "utf-8")) as Record<
      string,
      unknown
    >;
  } catch {
    return null;
  }
}

describe("qt-188: first-run AI hint gating", () => {
  it("default mode never prints `For AI agent instructions:` line (regression lock on qt-185 closure)", () => {
    if (!fs.existsSync(NARK_BIN)) {
      throw new Error(
        `Expected built CLI at ${NARK_BIN}. Run \`npm run build\` before \`npm test\`.`,
      );
    }
    const tmpHome = freshHome("test1");
    const { stdout } = runNark([], tmpHome);
    const plain = stripAnsi(stdout);
    // qt-185 moved this line into the verbose-only block. qt-188 adds the
    // regression lock here so a future refactor can't silently bring it
    // back into default mode.
    expect(plain).not.toContain("For AI agent instructions:");
  }, 30_000);

  it("compact `AI fix:` hint prints on first violation-bearing scan, then never again on the same HOME", () => {
    if (!fs.existsSync(NARK_BIN)) {
      throw new Error(
        `Expected built CLI at ${NARK_BIN}. Run \`npm run build\` before \`npm test\`.`,
      );
    }
    const tmpHome = freshHome("test2");

    // First run: hint MUST appear, and the flag MUST be persisted.
    const first = runNark([], tmpHome);
    const firstPlain = stripAnsi(first.stdout);
    expect(firstPlain).toContain("AI fix:      nark --instructions-path");
    const cfgAfterFirst = readTelemetryConfig(tmpHome);
    expect(cfgAfterFirst).not.toBeNull();
    expect(cfgAfterFirst?.["aiHintShown"]).toBe(true);

    // Second run: hint MUST NOT appear (suppressed by persisted flag).
    const second = runNark([], tmpHome);
    const secondPlain = stripAnsi(second.stdout);
    expect(secondPlain).not.toContain("AI fix:");

    // Third run: still suppressed (idempotent).
    const third = runNark([], tmpHome);
    const thirdPlain = stripAnsi(third.stdout);
    expect(thirdPlain).not.toContain("AI fix:");
  }, 60_000);

  it("--verbose always prints `For AI agent instructions:` and does NOT pollute the first-run gate", () => {
    if (!fs.existsSync(NARK_BIN)) {
      throw new Error(
        `Expected built CLI at ${NARK_BIN}. Run \`npm run build\` before \`npm test\`.`,
      );
    }
    const tmpHome = freshHome("test3");

    // First --verbose run on fresh HOME: line 1456 must appear (qt-185 path).
    const first = runNark(["--verbose"], tmpHome);
    const firstPlain = stripAnsi(first.stdout);
    expect(firstPlain).toContain(
      "For AI agent instructions: nark --instructions-path",
    );

    // Second --verbose run: line still appears. --verbose is never gated.
    const second = runNark(["--verbose"], tmpHome);
    const secondPlain = stripAnsi(second.stdout);
    expect(secondPlain).toContain(
      "For AI agent instructions: nark --instructions-path",
    );

    // --verbose uses the full-report renderer (NOT printCompactReport),
    // so the qt-188 gate at line 2109 was never reached. The on-disk
    // `aiHintShown` flag must NOT have been written. This proves
    // --verbose did not pollute the gate for the next default-mode user.
    const cfg = readTelemetryConfig(tmpHome);
    if (cfg !== null) {
      expect(cfg["aiHintShown"]).not.toBe(true);
    }
  }, 60_000);
});
