/**
 * Convention Mining — Wave 0 RED tests.
 *
 * Tests for PH1-R3 / PH1-R3a / PH1-R3b: the convention-miner attaches a
 * `conventionMatch` envelope to a violation when the rest of the repo
 * demonstrably uses a recognizable convention at the same call site.
 *
 * These tests run against the existing analyzer pipeline and therefore
 * CURRENTLY FAIL — `Violation.conventionMatch` does not exist yet. Wave 3
 * introduces the miner that populates the field; Wave 1 first adds the
 * type. RED state confirmed at scaffold-time.
 *
 * Fixture layout:
 *   src/v2/fixtures/convention-mining/
 *     ├── fixtureA.ts  (3 passing sites — axios.get wrapped in try/catch)
 *     ├── fixtureB.ts  (2 passing sites)
 *     └── violation.ts (1 violation site — axios.get with no try/catch)
 *
 * Acceptance:
 *   PH1-R3  — violation in violation.ts has conventionMatch with
 *             pattern_id "try-catch:direct", site_count == 5, match_ratio
 *             == 1.0, supporting_sites[].length >= 1.
 *   PH1-R3a — when only 2 passing sites are visible, conventionMatch is
 *             ABSENT (undefined, not null) — threshold floor is 3.
 *   PH1-R3b — cross-file aggregation: scanning only fixtureA + violation
 *             yields site_count == 3, proving fixtureB contributes the
 *             remaining 2 sites in the full-corpus scan.
 */

import { describe, it, expect, beforeAll } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import { loadCorpus } from "../../corpus-loader.js";
import { UniversalAnalyzer } from "../analyzer.js";
import { ThrowingFunctionDetector } from "../plugins/throwing-function-detector.js";
import { PropertyChainDetector } from "../plugins/property-chain-detector.js";
import { EventListenerDetector } from "../plugins/event-listener-detector.js";
import { EventListenerAbsencePlugin } from "../plugins/event-listener-absence.js";
import { InstanceTrackerPlugin } from "../plugins/instance-tracker.js";
import type { PackageContract } from "../../types.js";
import type { Violation } from "../types/index.js";
import { CORPUS_PATH } from "./harness.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const FIXTURE_DIR = path.resolve(__dirname, "convention-mining");

// ──────────────────────────────────────────────────────────────────────────────
// Shape contract that Wave 1 will add to Violation.
// ──────────────────────────────────────────────────────────────────────────────

interface ConventionMatch {
  pattern_id: string;
  supporting_sites: Array<{ file: string; line: number }>;
  site_count: number;
  match_ratio: number;
}

function readConvention(v: Violation): ConventionMatch | undefined {
  // @ts-expect-error Wave 1 adds the `conventionMatch` field to Violation.
  return v.conventionMatch as ConventionMatch | undefined;
}

// ──────────────────────────────────────────────────────────────────────────────
// Multi-file harness — analyzer must see ALL fixture files so the miner
// can observe passing sites. We then filter to violations in violation.ts.
// ──────────────────────────────────────────────────────────────────────────────

async function runMultiFile(
  includeFiles: string[],
  corpusPath: string = CORPUS_PATH,
): Promise<Violation[]> {
  const corpusResult = await loadCorpus(corpusPath);
  if (corpusResult.errors.length > 0) {
    const fatal = corpusResult.errors.filter((e) => /axios/i.test(e));
    if (fatal.length > 0) {
      throw new Error(`Corpus load failed: ${fatal.join(", ")}`);
    }
  }
  const contracts: Map<string, PackageContract> = corpusResult.contracts;

  // Write a per-run temp tsconfig that includes the requested fixture files.
  const stamp = `__cm-tsconfig-${Date.now()}-${Math.random().toString(36).slice(2)}.json`;
  const tmpTsconfig = path.join(FIXTURE_DIR, stamp);
  fs.writeFileSync(
    tmpTsconfig,
    JSON.stringify(
      {
        compilerOptions: {
          target: "ES2020",
          module: "commonjs",
          lib: ["ES2020"],
          strict: false,
          esModuleInterop: true,
          skipLibCheck: true,
          moduleResolution: "node",
        },
        include: includeFiles,
      },
      null,
      2,
    ),
  );

  try {
    // Build detection maps from contracts (mirror harness.ts).
    const factoryToPackage = new Map<string, string>();
    const classToPackage = new Map<string, string>();
    const typeToPackage = new Map<string, string>();
    const promiseFactoryToPackage = new Map<string, string>();
    const instanceChainMethodToPackage = new Map<string, string>();
    const awaitablePropertyToFunctionName = new Map<string, string>();
    const callableFactoryFunctionName = new Map<string, string>();

    for (const [packageName, contract] of contracts.entries()) {
      const detection = (contract as PackageContract).detection;
      if (!detection) continue;
      for (const cls of detection.class_names || [])
        classToPackage.set(cls, packageName);
      for (const factory of detection.factory_methods || [])
        factoryToPackage.set(factory, packageName);
      for (const typeName of detection.type_names || [])
        typeToPackage.set(typeName, packageName);
      for (const method of detection.promise_factory_methods || [])
        promiseFactoryToPackage.set(method, packageName);
      for (const method of detection.instance_chain_methods || [])
        instanceChainMethodToPackage.set(method, packageName);
      if (detection.awaitable_properties) {
        for (const [propName, funcName] of Object.entries(
          detection.awaitable_properties,
        )) {
          awaitablePropertyToFunctionName.set(
            `${packageName}:${propName}`,
            funcName as string,
          );
        }
      }
      if (detection.callable_factory_function_name) {
        callableFactoryFunctionName.set(
          packageName,
          detection.callable_factory_function_name,
        );
      }
    }

    const instanceTracker = new InstanceTrackerPlugin(
      factoryToPackage,
      classToPackage,
      typeToPackage,
      promiseFactoryToPackage,
      instanceChainMethodToPackage,
    );

    const analyzer = new UniversalAnalyzer(
      { tsConfigPath: tmpTsconfig, corpusPath },
      contracts,
    );

    analyzer.registerPlugin(instanceTracker);
    analyzer.registerPlugin(
      new ThrowingFunctionDetector(
        instanceTracker,
        awaitablePropertyToFunctionName,
        callableFactoryFunctionName,
      ),
    );
    analyzer.registerPlugin(new PropertyChainDetector(instanceTracker));
    analyzer.registerPlugin(new EventListenerDetector());
    analyzer.registerPlugin(new EventListenerAbsencePlugin(contracts));

    analyzer.initialize();
    const result = analyzer.analyze();

    const violations: Violation[] = [];
    for (const fileResult of result.files) {
      if (fileResult.file.includes("violation.ts")) {
        violations.push(...fileResult.violations.filter((v) => !v.suppressed));
      }
    }
    return violations;
  } finally {
    try {
      fs.unlinkSync(tmpTsconfig);
    } catch {
      /* ignore */
    }
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// PH1-R3: conventionMatch attached when >=5 supporting sites exist.
// ──────────────────────────────────────────────────────────────────────────────

describe("convention-mining: PH1-R3 — full corpus, 5 passing sites", () => {
  let violations: Violation[];

  beforeAll(async () => {
    violations = await runMultiFile([
      "fixtureA.ts",
      "fixtureB.ts",
      "violation.ts",
    ]);
  });

  it("analyzer flags violation.ts (sanity)", () => {
    expect(
      violations.length,
      "expected at least one violation in violation.ts; if zero, the fixture is broken",
    ).toBeGreaterThan(0);
  });

  it("violation carries conventionMatch with pattern_id, site_count=5, ratio=1.0 (RED until Wave 3)", () => {
    const v = violations[0];
    const cm = readConvention(v);

    expect(
      cm,
      "Wave 3 miner must attach conventionMatch when >=5 supporting sites exist",
    ).toBeDefined();
    expect(cm?.pattern_id).toBe("try-catch:direct");
    expect(cm?.site_count).toBe(5);
    expect(cm?.match_ratio).toBe(1.0);
    expect(cm?.supporting_sites.length).toBeGreaterThanOrEqual(1);
    expect(cm?.supporting_sites.length).toBeLessThanOrEqual(5);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// PH1-R3a: below threshold (2 passing sites) — conventionMatch absent.
// ──────────────────────────────────────────────────────────────────────────────

describe("convention-mining: PH1-R3a — below threshold, conventionMatch absent", () => {
  let violations: Violation[];

  beforeAll(async () => {
    // Only fixtureB contributes (2 passing sites) — below the 3-site floor.
    violations = await runMultiFile(["fixtureB.ts", "violation.ts"]);
  });

  it("analyzer still flags violation.ts (sanity)", () => {
    expect(violations.length).toBeGreaterThan(0);
  });

  it("conventionMatch is undefined when only 2 passing sites exist (RED until Wave 3)", () => {
    const v = violations[0];
    const cm = readConvention(v);

    // Two-part assertion forces RED today AND survives once Wave 1+3 land:
    //   1. detectionTrace must be present (Wave 1 ships this) - proves the
    //      miner actually ran and consciously chose to omit conventionMatch.
    //   2. conventionMatch must be undefined (NOT null) - Wave 3 contract:
    //      the miner uses absence, not a sentinel, to signal "below threshold".
    // Today (Wave 0) assertion #1 fails because detectionTrace doesn't exist.
    // @ts-expect-error Wave 1 adds the `detectionTrace` field.
    const trace = v.detectionTrace as unknown;
    expect(
      trace,
      "Wave 1 must populate detectionTrace so we can prove miner ran (even when conventionMatch is omitted)",
    ).toBeDefined();

    expect(
      cm,
      "miner must omit conventionMatch below the 3-site threshold (NOT null, undefined)",
    ).toBeUndefined();
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// PH1-R3b: cross-file aggregation — only fixtureA + violation -> site_count 3.
// ──────────────────────────────────────────────────────────────────────────────

describe("convention-mining: PH1-R3b — cross-file aggregation", () => {
  let violationsA: Violation[];

  beforeAll(async () => {
    // Only fixtureA contributes (3 passing sites) — fixtureB excluded.
    violationsA = await runMultiFile(["fixtureA.ts", "violation.ts"]);
  });

  it("analyzer flags violation.ts (sanity)", () => {
    expect(violationsA.length).toBeGreaterThan(0);
  });

  it("site_count is 3 (only fixtureA), proving fixtureB contributes in the full scan (RED until Wave 3)", () => {
    const v = violationsA[0];
    const cm = readConvention(v);

    expect(
      cm,
      "Wave 3 miner must attach conventionMatch when 3 sites are visible (threshold met)",
    ).toBeDefined();
    expect(cm?.site_count).toBe(3);
  });
});
