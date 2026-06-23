/**
 * Tests — qt-187: the INSIGHTS section must only mention packages whose call
 * sites appear in the analyzed file set. Packages found only in a parent
 * workspace's `package.json` (orphan deps walked up by package discovery)
 * have `callSiteCount === 0` and must not be listed as "packages have zero
 * violations" or "packages don't have contracts yet."
 *
 * Concrete scenario from the 2026-06-23 CLI Output Polish handoff Task 5:
 * scanning `nark-corpus/packages/axios/fixtures/` from the parent workspace
 * (whose package.json declares unrelated deps) was producing INSIGHTS
 * mentioning @sentry/node, ajv, typescript, etc. — none of which are
 * imported by the fixture source. The fix lives at the rendering layer in
 * `src/reporters/positive-evidence.ts`; this test pins both the regression
 * suppression AND the common-case positive guard ("filter must not over-trim
 * legitimate results").
 *
 * Scaffolding mirrors `path-consolidation.test.ts`: execSync against
 * `dist/index.js`, `NARK_TELEMETRY=off` + mkdtempSync HOME to isolate from
 * login state / global config. Silent-skip replaced with `throw new Error`
 * per qt-186 pattern — a missing build artifact is a contributor mistake
 * worth surfacing, not a reason to silently pass.
 *
 * Why --verbose: the INSIGHTS section only renders in verbose mode (full
 * positive-evidence report). Compact / default mode prints a different
 * summary. To exercise the renderer being modified, both tests run with
 * --verbose.
 *
 * Why NARK_ALLOW_MISSING_DEPS=1: the temp fixture lives under $TMPDIR
 * which has no node_modules. Without this flag nark refuses to scan.
 * The flag only affects type resolution — package discovery still walks
 * up to find the orphan-bearing parent package.json, which is the exact
 * vector the regression test is locking in.
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
const CORPUS_PATH = path.resolve(REPO_ROOT, "..", "nark-corpus");

function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

/**
 * Construct a temp project that imports axios cleanly (no violations) and
 * declares a few orphan deps in its OWN package.json. Package discovery
 * will additionally walk UP and read the parent workspace's package.json
 * — every dep there is also an orphan from the analyzed-file perspective.
 *
 * After the fix:
 *   - axios appears in INSIGHTS (callSiteCount > 0, passing)
 *   - no orphan dep name (from local OR parent package.json) appears
 */
function setupOrphanFixture(opts: { withAxiosImport: boolean }): {
  fixtureDir: string;
  tmpHome: string;
} {
  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "nark-qt187-"));
  fs.writeFileSync(
    path.join(fixtureDir, "package.json"),
    JSON.stringify(
      {
        name: "orphan-test",
        version: "0.0.0",
        dependencies: {
          "@sentry/node": "*",
          ajv: "*",
          typescript: "*",
        },
      },
      null,
      2
    )
  );
  fs.writeFileSync(
    path.join(fixtureDir, "tsconfig.json"),
    JSON.stringify(
      {
        compilerOptions: {
          target: "ES2020",
          module: "commonjs",
          strict: true,
          esModuleInterop: true,
          skipLibCheck: true,
        },
        include: ["src/**/*.ts"],
      },
      null,
      2
    )
  );
  fs.mkdirSync(path.join(fixtureDir, "src"), { recursive: true });
  if (opts.withAxiosImport) {
    // Reuse the canonical axios proper-error-handling fixture — it covers
    // ALL axios postconditions (try/catch + isAxiosError + 429 handling +
    // timeout). Copying the canonical file keeps "passing" semantics
    // synchronized with the corpus: when the axios contract tightens, the
    // canonical fixture is updated, and this test gets the same treatment
    // for free.
    const canonical = path.resolve(
      REPO_ROOT,
      "..",
      "nark-corpus",
      "packages",
      "axios",
      "fixtures",
      "proper-error-handling.ts"
    );
    if (!fs.existsSync(canonical)) {
      throw new Error(
        `canonical axios proper-error-handling fixture missing at ${canonical} — corpus layout changed?`
      );
    }
    fs.copyFileSync(
      canonical,
      path.join(fixtureDir, "src", "proper-error-handling.ts")
    );
  } else {
    // No imports — exercises the pure-orphan case. Package discovery still
    // walks the package.json files; INSIGHTS should mention nothing.
    fs.writeFileSync(
      path.join(fixtureDir, "src", "empty.ts"),
      "export const noop = () => {};\n"
    );
  }
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "nark-qt187-home-"));
  return { fixtureDir, tmpHome };
}

function runNarkVerbose(fixtureDir: string, tmpHome: string): string {
  const tsconfig = path.join(fixtureDir, "tsconfig.json");
  return execSync(
    `node ${NARK_BIN} --tsconfig ${tsconfig} --corpus ${CORPUS_PATH} --report-only --verbose`,
    {
      env: {
        ...process.env,
        NARK_TELEMETRY: "off",
        NARK_ALLOW_MISSING_DEPS: "1",
        HOME: tmpHome,
      },
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    }
  );
}

describe("qt-187: INSIGHTS filters out orphan deps (no call sites)", () => {
  it("INSIGHTS omits orphan deps that have no call sites in analyzed files", () => {
    if (!fs.existsSync(NARK_BIN)) {
      throw new Error(
        "dist/index.js not found — run `npm run build` first (qt-186 pattern: no silent skip)"
      );
    }
    const { fixtureDir, tmpHome } = setupOrphanFixture({
      withAxiosImport: false,
    });
    const stdout = runNarkVerbose(fixtureDir, tmpHome);
    const plain = stripAnsi(stdout);

    // Locate the INSIGHTS block — between the "💡 INSIGHTS" header and the
    // next "🎯 RECOMMENDATIONS" section or the "═══" footer separator.
    const insightsMatch = plain.match(
      /💡 INSIGHTS[\s\S]*?(?=🎯 RECOMMENDATIONS|═══)/
    );
    expect(insightsMatch, "INSIGHTS block must appear in output").not.toBeNull();
    const insightsBlock = insightsMatch![0];

    // The local-orphan deps must NOT appear in INSIGHTS. These are declared
    // in this fixture's own package.json but never imported by any source
    // file in the tsconfig program.
    expect(insightsBlock).not.toMatch(/@sentry\/node/);
    expect(insightsBlock).not.toMatch(/\bajv\b/);
    expect(insightsBlock).not.toMatch(/\btypescript\b/);

    // The "N packages have zero violations" line and the "N packages don't
    // have contracts yet" line must either be ABSENT (filter dropped them
    // because no package has call sites) or, if present, must reference
    // only packages with non-zero call sites. Since this fixture imports
    // nothing, both lines should be absent — assert that.
    expect(insightsBlock).not.toMatch(/packages have zero violations/);
    expect(insightsBlock).not.toMatch(/packages don't have contracts yet/);
  }, 60_000);

  it("INSIGHTS still mentions actually-imported packages (filter does not over-trim)", () => {
    if (!fs.existsSync(NARK_BIN)) {
      throw new Error(
        "dist/index.js not found — run `npm run build` first (qt-186 pattern: no silent skip)"
      );
    }
    const { fixtureDir, tmpHome } = setupOrphanFixture({
      withAxiosImport: true,
    });
    const stdout = runNarkVerbose(fixtureDir, tmpHome);
    const plain = stripAnsi(stdout);

    const insightsMatch = plain.match(
      /💡 INSIGHTS[\s\S]*?(?=🎯 RECOMMENDATIONS|═══)/
    );
    expect(insightsMatch, "INSIGHTS block must appear in output").not.toBeNull();
    const insightsBlock = insightsMatch![0];

    // axios IS imported (callSiteCount > 0) and the fixture is clean, so the
    // "passing packages" insight must appear AND must mention axios. Catches
    // the regression "you broke INSIGHTS entirely by filtering everything to
    // zero" — without this guard, an executor could pass the first test by
    // dropping the filter sites altogether.
    expect(insightsBlock).toMatch(/packages have zero violations/);
    expect(insightsBlock).toMatch(/\baxios\b/);

    // Orphans still suppressed in this scenario.
    expect(insightsBlock).not.toMatch(/@sentry\/node/);
    // `typescript` is allowed to appear here ONLY if it's imported with a
    // call site — it isn't in this fixture, so it must be absent.
    expect(insightsBlock).not.toMatch(/\btypescript\b/);
    expect(insightsBlock).not.toMatch(/\bajv\b/);
  }, 60_000);
});
