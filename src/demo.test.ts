/**
 * Tests — qt-256: --demo flag bundles a sample project.
 * qt-186: extended regression coverage so the demo can never silently
 *         regress to "0 violations" or "demo files not in the pack manifest"
 *         again. The original `\d+ violations?` regex matched "0 violations"
 *         and the `if (!fs.existsSync(NARK_BIN)) return` early-out silently
 *         skipped CI runs from a fresh clone — both removed here.
 *
 * These are integration smoke tests, not unit tests. The --demo flag's whole
 * value is "you see real Nark output without setting anything up," so the
 * test asserts the artifact (the demo/ directory) actually ships with the
 * package and the scanner finds the expected violations end-to-end.
 *
 * We invoke `node dist/index.js` rather than importing main() directly so
 * the test exercises the CLI surface — flag parsing, banner output, exit
 * code — the same way `npx nark --demo` does in production.
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
const DEMO_DIR = path.join(REPO_ROOT, "demo");

describe("qt-256: demo fixture", () => {
  it("ships every file the --demo flag needs", () => {
    expect(fs.existsSync(path.join(DEMO_DIR, "tsconfig.json"))).toBe(true);
    expect(fs.existsSync(path.join(DEMO_DIR, "package.json"))).toBe(true);
    expect(fs.existsSync(path.join(DEMO_DIR, "types.d.ts"))).toBe(true);
    expect(fs.existsSync(path.join(DEMO_DIR, "src", "api-client.ts"))).toBe(
      true,
    );
    expect(fs.existsSync(path.join(DEMO_DIR, "src", "payments.ts"))).toBe(true);
    expect(fs.existsSync(path.join(DEMO_DIR, "src", "users.ts"))).toBe(true);
  });

  it("is listed in package.json files[] so npm publish includes it", () => {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf-8"),
    );
    expect(pkg.files).toContain("demo/");
  });

  it("finds ≥3 violations across all three demo packages", () => {
    // qt-186: replaced the original `if (!fs.existsSync(NARK_BIN)) return;`
    // silent skip. The skip was added as a fresh-clone contributor
    // convenience, but it's what masked the 0-violations regression that
    // motivated qt-186 — the test passed because it never ran. The
    // prepublishOnly + CI build hooks guarantee dist/ exists; the only
    // env where this throw fires is `npm test` from a fresh clone with no
    // prior build, which is one-time contributor friction we accept.
    if (!fs.existsSync(NARK_BIN)) {
      throw new Error(
        `Expected built CLI at ${NARK_BIN}. Run \`npm run build\` before \`npm test\`.`,
      );
    }
    // NARK_TELEMETRY=off keeps the test offline-clean and stops the test
    // from hanging on the telemetry POST timeout. --quiet keeps the output
    // small. `2>&1` folds the stderr banner into the captured stdout so
    // execSync's return covers both streams in one assertion surface.
    // HOME is redirected to a writable tmp dir so the CLI's `~/.nark/projects/...`
    // side artifacts land somewhere the sandbox + restricted CI envs allow.
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "nark-demo-test-"));
    const out = execSync(
      `node ${NARK_BIN} --demo --quiet --no-positive-report --report-only 2>&1`,
      {
        env: { ...process.env, NARK_TELEMETRY: "off", HOME: tmpHome },
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      },
    );

    // Banner identifies the demo so the user can't confuse it for a scan of
    // their own code. Written to stderr in the CLI, captured here via 2>&1.
    expect(out).toContain("Nark demo");
    expect(out).toContain("bundled sample project");

    // Each demo file should fire at least one violation, addressed by the
    // package whose profile catches it. Exact wording can drift as profiles
    // tighten; assert by package name + filename only.
    expect(out).toMatch(/axios[\s\S]*api-client\.ts/);
    expect(out).toMatch(/stripe[\s\S]*payments\.ts/);
    expect(out).toMatch(/@prisma\/client[\s\S]*users\.ts/);

    // qt-186: parsed violation count must be ≥3 (one per demo file).
    // The original regex `/\d+ violations?/` matched `0 violations` and
    // silently accepted the regression. Parse the integer and assert the
    // floor so a profile-drift or wiring regression that drops the demo to
    // 0 violations again fails the suite.
    const m = out.match(/(\d+)\s+violations?/);
    expect(
      m,
      "expected output to contain '<N> violations' or '<N> violation'",
    ).not.toBeNull();
    const count = Number(m![1]);
    expect(
      count,
      `expected ≥3 violations, got ${count}. Full output:\n${out}`,
    ).toBeGreaterThanOrEqual(3);
  }, 30_000);

  it("npm pack --dry-run includes demo source files and types.d.ts", () => {
    // qt-186: lock the package manifest so a stray `.npmignore` or a
    // misconfigured `prepublishOnly` step that nukes the demo/ files can't
    // ship without a test failure. The plan's H1 hypothesis (types.d.ts
    // missing from pack) is refuted today — but it's cheap to lock the
    // manifest so the regression vector closes for good.
    //
    // npm pack writes the file manifest to stderr (the package metadata
    // table); `2>&1` folds it into stdout for assertion. 30s timeout
    // because the pack can be slow on a cold cache (prepublishOnly runs
    // `npm run build` which is ~1-2s).
    const out = execSync("npm pack --dry-run 2>&1", {
      cwd: REPO_ROOT,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    expect(out).toContain("demo/types.d.ts");
    expect(out).toContain("demo/tsconfig.json");
    expect(out).toContain("demo/package.json");
    expect(out).toContain("demo/src/api-client.ts");
    expect(out).toContain("demo/src/payments.ts");
    expect(out).toContain("demo/src/users.ts");
  }, 30_000);
});
