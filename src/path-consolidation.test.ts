/**
 * Tests — qt-185: the post-scan path output must consolidate to ONE line in
 * default mode. The prior 5-path `Reports written to:` block + the three
 * legacy lines (`Scan results saved to`, `Violation details:`, `For AI
 * agent instructions:`) all move behind `--verbose`.
 *
 * Prerequisites:
 * - qt-183 gated the five `[verbose]`-prefixed log sites + PII footer
 * - qt-184 flipped the broader `verbose` local to OFF by default, so the
 *   5-path block (line 1418 of src/index.ts) is already only printed when
 *   `--verbose` is set. qt-185 ADDS the consolidated one-line `Results:`
 *   pointer to the default-mode branch (line ~1491 `else if`).
 *
 * Why we also assert on the displayed path shape:
 * - `~/` (tilde-home prefix) — readable in marketing screenshots, avoids
 *   leaking the user's home directory name.
 * - short displayProjectId (`<basename>-<6char-hex>`) — replaces the 80-char
 *   `-Users-<user>-WebstormProjects-...-corpus` encoded form. The on-disk
 *   directory naming is UNCHANGED (encodeProjectPath still runs), only the
 *   DISPLAYED path uses the short form.
 *
 * Why the on-disk regression guard: if a refactor accidentally also swaps
 * the on-disk naming to displayProjectId, existing users' `~/.nark/projects/`
 * state would orphan. The test asserts the encoded dir (starting with `-`)
 * still appears in `<HOME>/.nark/projects/` after a default-mode run.
 *
 * Mirror of qt-183 / qt-184 test scaffolding: `node dist/index.js --demo
 * --report-only` with `NARK_TELEMETRY=off` + `mkdtempSync` HOME, and the
 * `if (!fs.existsSync(NARK_BIN)) return;` skip-when-no-dist guard so a
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

// Strip ANSI escape sequences (chalk styling) so assertions can match the
// plain text content of the line. The Results line is chalk.gray-styled.
function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

function runNark(extraFlags: string[]): { stdout: string; home: string } {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "nark-pc-test-"));
  const flags = ["--demo", "--report-only", ...extraFlags].join(" ");
  const stdout = execSync(`node ${NARK_BIN} ${flags} 2>&1`, {
    env: { ...process.env, NARK_TELEMETRY: "off", HOME: tmpHome },
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
  });
  return { stdout, home: tmpHome };
}

describe("qt-185: post-scan path output consolidated", () => {
  it("default mode prints exactly one `Results:` line starting with `~/.nark/projects/`", () => {
    if (!fs.existsSync(NARK_BIN)) {
      return;
    }
    const { stdout } = runNark([]);
    const plain = stripAnsi(stdout);
    // Count Results: occurrences — must be exactly one.
    const matches = plain.match(/\bResults: /g) ?? [];
    expect(matches.length).toBe(1);
    // The Results line must use ~/ prefix and target ~/.nark/projects/.
    expect(plain).toMatch(/\bResults: ~\/\.nark\/projects\//);
  }, 30_000);

  it("default mode suppresses the 5-path block and the three legacy lines", () => {
    if (!fs.existsSync(NARK_BIN)) {
      return;
    }
    const { stdout } = runNark([]);
    const plain = stripAnsi(stdout);
    expect(plain).not.toContain("Reports written to");
    expect(plain).not.toContain("Scan results saved to");
    expect(plain).not.toContain("Violation details:");
    expect(plain).not.toContain("For AI agent instructions:");
  }, 30_000);

  it("default mode Results line contains no /Users/<name>/ absolute prefix", () => {
    if (!fs.existsSync(NARK_BIN)) {
      return;
    }
    const { stdout } = runNark([]);
    const plain = stripAnsi(stdout);
    // Scope: ONLY the Results line, not the entire stdout. The demo banner
    // emits `Source: /Users/.../demo` which is pre-existing demo-specific
    // UX and unrelated to qt-185's post-scan path consolidation. qt-185's
    // contract is that the Results line uses `~/` instead of `/Users/`.
    const resultsLine = plain.split("\n").find((l) => l.includes("Results: "));
    expect(resultsLine).toBeDefined();
    expect(resultsLine ?? "").not.toContain("/Users/");
  }, 30_000);

  it("default mode displayed project id is the short form, not the 80-char encoded form", () => {
    if (!fs.existsSync(NARK_BIN)) {
      return;
    }
    const { stdout } = runNark([]);
    const plain = stripAnsi(stdout);
    // First assert the Results line exists — without it the next check
    // would vacuously pass and hide regressions.
    expect(plain).toMatch(/\bResults: ~\//);
    // The long encoded form contains `-Users-` (encodeProjectPath replaces
    // `/` with `-` on an absolute path that starts with `/Users/...`).
    // The displayed (short) form is `<basename>-<6hex>` and must NOT
    // contain `-Users-`.
    const resultsLine = plain.split("\n").find((l) => l.includes("Results: "));
    expect(resultsLine).toBeDefined();
    expect(resultsLine ?? "").not.toContain("-Users-");
  }, 30_000);

  it("`--verbose` restores the original 5-path `Reports written to:` block and the three legacy lines", () => {
    if (!fs.existsSync(NARK_BIN)) {
      return;
    }
    const { stdout } = runNark(["--verbose"]);
    const plain = stripAnsi(stdout);
    expect(plain).toContain("Reports written to:");
    expect(plain).toContain("Scan results saved to");
    expect(plain).toContain("Violation details:");
    expect(plain).toContain("For AI agent instructions:");
    // One of the 5 paths in the original block — the d3 visualization line.
    expect(plain).toContain("index.html (interactive visualization)");
    // Under --verbose the new consolidated default-mode `Results:` line
    // should NOT appear (verbose shows the full block instead).
    expect(plain).not.toMatch(/\bResults: ~\//);
  }, 30_000);

  it("on-disk encoded project directory unchanged after default-mode run", () => {
    if (!fs.existsSync(NARK_BIN)) {
      return;
    }
    const { home } = runNark([]);
    const projectsDir = path.join(home, ".nark", "projects");
    expect(fs.existsSync(projectsDir)).toBe(true);
    const entries = fs.readdirSync(projectsDir);
    // The on-disk encoded form prepends '-' and replaces every '/' with '-'.
    // At least one entry must start with '-' to prove encodeProjectPath()
    // still drives on-disk naming.
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.some((e) => e.startsWith("-"))).toBe(true);
  }, 30_000);
});
