/**
 * Tests — qt-184: the broader `--verbose` default must flip from ON-by-default
 * (today: `verbose = !options.quiet`) to OFF-by-default (`verbose =
 * options.verbose === true`), and the lean default surface must end with one
 * dim hint line pointing users at `--verbose` for diagnostics.
 *
 * Prerequisite: qt-183 already gated the five `[verbose]`-prefixed log sites
 * + the PII-revealing scan-uploaded footer behind a separate `verboseFlag =
 * options.verbose === true` predicate (src/index.ts:512). That predicate is
 * INTENTIONALLY narrower than the broader `verbose` local at src/index.ts:504
 * — qt-184 is the task that flips the broader local too.
 *
 * Why we test `--quiet --verbose` together: the qt-183 SUMMARY explicitly
 * called out that the two flags become independent axes after qt-184 lands.
 * Today: `--quiet` toggles BOTH the compact-report rendering AND the broader
 * verbose surface (because `verbose = !options.quiet`). After qt-184: only
 * `--verbose` controls the broader surface, `--quiet` controls only report
 * compaction. Passing `--quiet --verbose` proves the decoupling — quiet must
 * suppress the banner but verbose must still emit the [verbose] trace.
 *
 * Why we test that the hint is SUPPRESSED under --verbose: ergonomics. No
 * point advertising a flag the user already passed. Stripe / Vercel / gh all
 * follow this pattern — terse default with a "Run with --verbose for ..."
 * footer, full output under --verbose with no footer.
 *
 * Mirror of qt-183's test pattern: `node dist/index.js --demo --report-only`
 * with `NARK_TELEMETRY=off` + `mkdtempSync` HOME for hermetic isolation, and
 * the `if (!fs.existsSync(NARK_BIN)) return;` skip-when-no-dist guard so a
 * fresh clone without `npm run build` does not fail this test.
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

const HINT_LINE = "Run with --verbose for telemetry details, timing breakdown, and full report paths.";

function runNark(extraFlags: string[]): string {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "nark-vdf-test-"));
  const flags = ["--demo", "--report-only", ...extraFlags].join(" ");
  return execSync(`node ${NARK_BIN} ${flags} 2>&1`, {
    env: { ...process.env, NARK_TELEMETRY: "off", HOME: tmpHome },
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
  });
}

describe("qt-184: verbose default flipped to false", () => {
  it("default mode prints the dim hint line pointing to --verbose", () => {
    if (!fs.existsSync(NARK_BIN)) {
      return;
    }
    const out = runNark([]);
    expect(out).toContain(HINT_LINE);
  }, 30_000);

  it("default mode does NOT print the verbose banner or dim status lines", () => {
    if (!fs.existsSync(NARK_BIN)) {
      return;
    }
    const out = runNark([]);
    // Banner from src/index.ts:525 — chalk.bold("\nNark Contract Verification\n")
    expect(out).not.toContain("Nark Contract Verification");
    // Dim status from src/index.ts:748
    expect(out).not.toContain("Loading contracts...");
    // Dim status from src/index.ts:1001
    expect(out).not.toContain("Analyzing TypeScript code...");
    // Dim status from src/index.ts:924
    expect(out).not.toContain("Discovering packages...");
  }, 30_000);

  it("--verbose mode SUPPRESSES the hint line (no point advertising an enabled flag)", () => {
    if (!fs.existsSync(NARK_BIN)) {
      return;
    }
    const out = runNark(["--verbose"]);
    expect(out).not.toContain("Run with --verbose for telemetry details");
    // Banner re-appears with the broader verbose surface restored
    expect(out).toContain("Nark Contract Verification");
    // qt-183 marker still fires under --verbose (proves verboseFlag wiring intact)
    expect(out).toMatch(/\[verbose\] Time breakdown:/);
  }, 30_000);

  it("--quiet --verbose keeps the two flags independent (quiet suppresses banner, verbose still emits trace)", () => {
    if (!fs.existsSync(NARK_BIN)) {
      return;
    }
    const out = runNark(["--quiet", "--verbose"]);
    // Quiet still suppresses the banner — proves quiet is no longer the broader-verbose toggle
    expect(out).not.toContain("Nark Contract Verification");
    // Verbose still produces the trace — proves verbose is independent of quiet
    expect(out).toMatch(/\[verbose\] Time breakdown:/);
  }, 30_000);
});
