/**
 * Tests — qt-256: --demo flag bundles a sample project.
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

  it("`node dist/index.js --demo` finds violations in all three demo packages", () => {
    // Smoke-test depends on a built dist/. If a contributor is running the
    // suite from a fresh clone with no build, skip rather than fail — the
    // build is the prerequisite, not the test target.
    if (!fs.existsSync(NARK_BIN)) {
      return;
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

    // Non-zero violation count gives the demo its whole purpose.
    expect(out).toMatch(/\d+ violations?/);
  }, 30_000);
});
