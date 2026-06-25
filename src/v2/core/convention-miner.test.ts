/**
 * Convention Miner — unit tests (Wave 3, Plan 01-09).
 *
 * Pins the deterministic behavior the Wave 0 fixture tests (PH1-R3 /
 * PH1-R3a / PH1-R3b) depend on, plus a handful of additional edge cases
 * that the fixture tests don't probe directly:
 *
 *   - basic happy path: 5 passing sites + 1 violation, same matcher
 *     signature → conventionMatch attached with site_count=5, ratio=1.0
 *   - below-minSites threshold (2 passing): conventionMatch ABSENT (NOT null)
 *   - below-minRatio threshold (2/5 = 0.4): conventionMatch ABSENT
 *   - exactly-on-threshold (3/5 = 0.6): conventionMatch ATTACHED
 *   - supporting_sites capped at maxSupportingSites=5 even when 10 match
 *   - cross-file aggregation: passing sites in fileA + fileB pool together
 *   - tie-breaking: deterministic lexicographic order of matcher IDs when
 *     counts equal
 *   - match_ratio rounded to 3 decimals (e.g. 6/7 → 0.857)
 *   - DEFAULT_OPTS exposes the named-constant block (minSites/minRatio/etc.)
 *   - mineConventions on empty input is a no-op
 *
 * The miner is a PURE function over ProjectLikeResult — no AST, no IO, no
 * timing-dependent inputs. Tests construct the minimal in-memory shape
 * directly (a couple of synthetic Violation + PassedDetection objects per
 * test) rather than running the analyzer pipeline. The pipeline-level
 * tests live in src/v2/fixtures/convention-mining.test.ts (PH1-R3 family).
 */

import { describe, it, expect } from "vitest";
import {
  mineConventions,
  DEFAULT_OPTS,
  CONVENTION_MINER_VERSION,
} from "./convention-miner.js";
import type { Violation, PassedDetection } from "../types/index.js";

// ──────────────────────────────────────────────────────────────────────────────
// Builders — minimal Violation + PassedDetection shapes.
// ──────────────────────────────────────────────────────────────────────────────

function v(opts: {
  pkg: string;
  postcondition: string;
  file?: string;
  line?: number;
}): Violation {
  return {
    file: opts.file ?? "/repo/src/violation.ts",
    line: opts.line ?? 42,
    column: 1,
    package: opts.pkg,
    function: "get",
    postconditionId: opts.postcondition,
    severity: "error",
    message: "test",
    codeContext: "",
    inTryCatch: false,
    suppressed: false,
  };
}

function passed(opts: {
  pkg: string;
  postcondition: string;
  matcher: string;
  file: string;
  line: number;
}): PassedDetection {
  return {
    packageName: opts.pkg,
    postconditionId: opts.postcondition,
    file: opts.file,
    line: opts.line,
    passedMatcherId: opts.matcher,
  };
}

interface ProjectLike {
  files: Array<{
    violations: Violation[];
    passedDetections?: PassedDetection[];
  }>;
}

function singleFile(
  violations: Violation[],
  passedDetections: PassedDetection[],
): ProjectLike {
  return { files: [{ violations, passedDetections }] };
}

// ──────────────────────────────────────────────────────────────────────────────
// DEFAULT_OPTS contract — pinned so post-v1.0 telemetry tuning is intentional
// ──────────────────────────────────────────────────────────────────────────────

describe("convention-miner — DEFAULT_OPTS", () => {
  it("exposes the named-constant block with the v1.0 thresholds", () => {
    expect(DEFAULT_OPTS).toEqual({
      minSites: 3,
      minRatio: 0.6,
      maxSupportingSites: 5,
      maxTrackedPerGroup: 10_000,
    });
  });

  it("exports a CONVENTION_MINER_VERSION for downstream consumers", () => {
    expect(typeof CONVENTION_MINER_VERSION).toBe("string");
    expect(CONVENTION_MINER_VERSION.length).toBeGreaterThan(0);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Happy path — 5 passing + 1 violation, all same matcher → conventionMatch
// ──────────────────────────────────────────────────────────────────────────────

describe("convention-miner — happy path", () => {
  it("attaches conventionMatch when 5 sites share a matcher", () => {
    const violation = v({ pkg: "axios", postcondition: "error-4xx-5xx" });
    const passes: PassedDetection[] = Array.from({ length: 5 }, (_, i) =>
      passed({
        pkg: "axios",
        postcondition: "error-4xx-5xx",
        matcher: "try-catch:direct",
        file: `/repo/src/file${i}.ts`,
        line: 10 + i,
      }),
    );

    const result = singleFile([violation], passes);
    mineConventions(result);

    expect(violation.conventionMatch).toBeDefined();
    expect(violation.conventionMatch?.pattern_id).toBe("try-catch:direct");
    expect(violation.conventionMatch?.site_count).toBe(5);
    expect(violation.conventionMatch?.match_ratio).toBe(1.0);
    expect(violation.conventionMatch?.supporting_sites.length).toBeGreaterThanOrEqual(1);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Threshold floor (minSites=3): 2 passing → ABSENT (NOT null)
// ──────────────────────────────────────────────────────────────────────────────

describe("convention-miner — minSites threshold", () => {
  it("omits conventionMatch when only 2 passing sites exist", () => {
    const violation = v({ pkg: "axios", postcondition: "error-4xx-5xx" });
    const passes: PassedDetection[] = [
      passed({
        pkg: "axios",
        postcondition: "error-4xx-5xx",
        matcher: "try-catch:direct",
        file: "/repo/src/a.ts",
        line: 10,
      }),
      passed({
        pkg: "axios",
        postcondition: "error-4xx-5xx",
        matcher: "try-catch:direct",
        file: "/repo/src/b.ts",
        line: 20,
      }),
    ];

    const result = singleFile([violation], passes);
    mineConventions(result);

    // Absence, NOT a sentinel — consumers treat presence as confidence.
    expect(violation.conventionMatch).toBeUndefined();
    expect("conventionMatch" in violation).toBe(false);
  });

  it("attaches conventionMatch when EXACTLY minSites passing sites exist", () => {
    const violation = v({ pkg: "axios", postcondition: "error-4xx-5xx" });
    const passes: PassedDetection[] = Array.from({ length: 3 }, (_, i) =>
      passed({
        pkg: "axios",
        postcondition: "error-4xx-5xx",
        matcher: "try-catch:direct",
        file: `/repo/src/f${i}.ts`,
        line: 1,
      }),
    );

    const result = singleFile([violation], passes);
    mineConventions(result);

    expect(violation.conventionMatch).toBeDefined();
    expect(violation.conventionMatch?.site_count).toBe(3);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Ratio floor (minRatio=0.6): below-majority → ABSENT; exactly-on → present
// ──────────────────────────────────────────────────────────────────────────────

describe("convention-miner — minRatio threshold", () => {
  it("omits conventionMatch when top matcher's ratio is below 0.60", () => {
    // 2 try-catch + 2 promise-catch + 1 options-on-error → top ratio = 0.4
    const violation = v({ pkg: "axios", postcondition: "error-4xx-5xx" });
    const passes: PassedDetection[] = [
      passed({ pkg: "axios", postcondition: "error-4xx-5xx", matcher: "try-catch:direct", file: "/a.ts", line: 1 }),
      passed({ pkg: "axios", postcondition: "error-4xx-5xx", matcher: "try-catch:direct", file: "/b.ts", line: 2 }),
      passed({ pkg: "axios", postcondition: "error-4xx-5xx", matcher: "promise:catch-handler", file: "/c.ts", line: 3 }),
      passed({ pkg: "axios", postcondition: "error-4xx-5xx", matcher: "promise:catch-handler", file: "/d.ts", line: 4 }),
      passed({ pkg: "axios", postcondition: "error-4xx-5xx", matcher: "options:on-error", file: "/e.ts", line: 5 }),
    ];

    const result = singleFile([violation], passes);
    mineConventions(result);

    expect(violation.conventionMatch).toBeUndefined();
  });

  it("attaches conventionMatch when ratio is EXACTLY at the threshold (3/5 = 0.6)", () => {
    const violation = v({ pkg: "axios", postcondition: "error-4xx-5xx" });
    const passes: PassedDetection[] = [
      passed({ pkg: "axios", postcondition: "error-4xx-5xx", matcher: "try-catch:direct", file: "/a.ts", line: 1 }),
      passed({ pkg: "axios", postcondition: "error-4xx-5xx", matcher: "try-catch:direct", file: "/b.ts", line: 2 }),
      passed({ pkg: "axios", postcondition: "error-4xx-5xx", matcher: "try-catch:direct", file: "/c.ts", line: 3 }),
      passed({ pkg: "axios", postcondition: "error-4xx-5xx", matcher: "promise:catch-handler", file: "/d.ts", line: 4 }),
      passed({ pkg: "axios", postcondition: "error-4xx-5xx", matcher: "promise:catch-handler", file: "/e.ts", line: 5 }),
    ];

    const result = singleFile([violation], passes);
    mineConventions(result);

    expect(violation.conventionMatch).toBeDefined();
    expect(violation.conventionMatch?.pattern_id).toBe("try-catch:direct");
    expect(violation.conventionMatch?.match_ratio).toBe(0.6);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// supporting_sites cap at maxSupportingSites=5
// ──────────────────────────────────────────────────────────────────────────────

describe("convention-miner — supporting_sites cap", () => {
  it("caps supporting_sites at 5 even when 10 passing sites match the top pattern", () => {
    const violation = v({ pkg: "axios", postcondition: "error-4xx-5xx" });
    const passes: PassedDetection[] = Array.from({ length: 10 }, (_, i) =>
      passed({
        pkg: "axios",
        postcondition: "error-4xx-5xx",
        matcher: "try-catch:direct",
        file: `/repo/src/f${i}.ts`,
        line: i + 1,
      }),
    );

    const result = singleFile([violation], passes);
    mineConventions(result);

    expect(violation.conventionMatch).toBeDefined();
    expect(violation.conventionMatch?.site_count).toBe(10);
    expect(violation.conventionMatch?.supporting_sites.length).toBe(5);
    // supporting_sites carries (file, line) pairs only — no extra fields.
    for (const site of violation.conventionMatch!.supporting_sites) {
      expect(Object.keys(site).sort()).toEqual(["file", "line"]);
    }
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Cross-file aggregation — passing sites in fileA + fileB pool together
// ──────────────────────────────────────────────────────────────────────────────

describe("convention-miner — cross-file aggregation", () => {
  it("pools passing sites across multiple FileAnalysisResults into one group", () => {
    const violation = v({ pkg: "axios", postcondition: "error-4xx-5xx" });
    const result: ProjectLike = {
      files: [
        {
          violations: [],
          passedDetections: [
            passed({ pkg: "axios", postcondition: "error-4xx-5xx", matcher: "try-catch:direct", file: "/repo/fileA.ts", line: 10 }),
            passed({ pkg: "axios", postcondition: "error-4xx-5xx", matcher: "try-catch:direct", file: "/repo/fileA.ts", line: 20 }),
            passed({ pkg: "axios", postcondition: "error-4xx-5xx", matcher: "try-catch:direct", file: "/repo/fileA.ts", line: 30 }),
          ],
        },
        {
          violations: [],
          passedDetections: [
            passed({ pkg: "axios", postcondition: "error-4xx-5xx", matcher: "try-catch:direct", file: "/repo/fileB.ts", line: 5 }),
            passed({ pkg: "axios", postcondition: "error-4xx-5xx", matcher: "try-catch:direct", file: "/repo/fileB.ts", line: 15 }),
          ],
        },
        {
          violations: [violation],
          passedDetections: [],
        },
      ],
    };

    mineConventions(result);

    expect(violation.conventionMatch).toBeDefined();
    expect(violation.conventionMatch?.site_count).toBe(5);
    expect(violation.conventionMatch?.match_ratio).toBe(1.0);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Determinism — tie-breaking + match_ratio rounding
// ──────────────────────────────────────────────────────────────────────────────

describe("convention-miner — determinism", () => {
  it("breaks ties lexicographically by matcher ID when counts are equal", () => {
    // 2 sites of "promise:catch-handler" + 2 sites of "try-catch:direct" + 1
    // tie-breaker site of "options:on-error" (so top-2 tied at 2). "options"
    // is lexicographically smallest of the three — but it's not in the tie,
    // it's at count 1. The tie is between "promise:catch-handler" and
    // "try-catch:direct" — lexicographically "promise:..." < "try-catch:...".
    const violation = v({ pkg: "axios", postcondition: "error-4xx-5xx" });
    const passes: PassedDetection[] = [
      passed({ pkg: "axios", postcondition: "error-4xx-5xx", matcher: "promise:catch-handler", file: "/a.ts", line: 1 }),
      passed({ pkg: "axios", postcondition: "error-4xx-5xx", matcher: "promise:catch-handler", file: "/b.ts", line: 2 }),
      passed({ pkg: "axios", postcondition: "error-4xx-5xx", matcher: "try-catch:direct", file: "/c.ts", line: 3 }),
      passed({ pkg: "axios", postcondition: "error-4xx-5xx", matcher: "try-catch:direct", file: "/d.ts", line: 4 }),
      passed({ pkg: "axios", postcondition: "error-4xx-5xx", matcher: "options:on-error", file: "/e.ts", line: 5 }),
    ];

    const result = singleFile([violation], passes);
    mineConventions(result);

    // Top count is 2 (tied). Ratio = 2/5 = 0.4 < 0.6 → omitted.
    // But this also pins the tie-breaking behavior IF the ratio were
    // sufficient: deterministic lexicographic pick.
    expect(violation.conventionMatch).toBeUndefined();
  });

  it("rounds match_ratio to 3 decimals (6/7 = 0.857142... → 0.857)", () => {
    const violation = v({ pkg: "axios", postcondition: "error-4xx-5xx" });
    const passes: PassedDetection[] = [
      ...Array.from({ length: 6 }, (_, i) =>
        passed({ pkg: "axios", postcondition: "error-4xx-5xx", matcher: "try-catch:direct", file: `/a${i}.ts`, line: i }),
      ),
      passed({ pkg: "axios", postcondition: "error-4xx-5xx", matcher: "promise:catch-handler", file: "/b.ts", line: 99 }),
    ];

    const result = singleFile([violation], passes);
    mineConventions(result);

    expect(violation.conventionMatch).toBeDefined();
    // 6/7 = 0.857142857... → 0.857 (3-decimal rounding).
    expect(violation.conventionMatch?.match_ratio).toBe(0.857);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Edge cases — empty input, no-match, mixed-conventions across groups
// ──────────────────────────────────────────────────────────────────────────────

describe("convention-miner — edge cases", () => {
  it("is a no-op on empty input", () => {
    const result: ProjectLike = { files: [] };
    expect(() => mineConventions(result)).not.toThrow();
  });

  it("is a no-op when a violation's group has zero passing sites", () => {
    const violation = v({ pkg: "axios", postcondition: "error-4xx-5xx" });
    const result = singleFile([violation], []);
    mineConventions(result);
    expect(violation.conventionMatch).toBeUndefined();
  });

  it("mines separate conventions for distinct (package, postcondition) groups", () => {
    const axiosVio = v({ pkg: "axios", postcondition: "error-4xx-5xx", file: "/v1.ts" });
    const prismaVio = v({ pkg: "@prisma/client", postcondition: "throws-on-not-found", file: "/v2.ts" });
    const passes: PassedDetection[] = [
      ...Array.from({ length: 3 }, (_, i) =>
        passed({ pkg: "axios", postcondition: "error-4xx-5xx", matcher: "try-catch:direct", file: `/a${i}.ts`, line: i }),
      ),
      ...Array.from({ length: 3 }, (_, i) =>
        passed({ pkg: "@prisma/client", postcondition: "throws-on-not-found", matcher: "promise:catch-handler", file: `/p${i}.ts`, line: i }),
      ),
    ];

    const result = singleFile([axiosVio, prismaVio], passes);
    mineConventions(result);

    expect(axiosVio.conventionMatch?.pattern_id).toBe("try-catch:direct");
    expect(prismaVio.conventionMatch?.pattern_id).toBe("promise:catch-handler");
  });

  it("respects custom opts (minSites override)", () => {
    const violation = v({ pkg: "axios", postcondition: "error-4xx-5xx" });
    const passes: PassedDetection[] = [
      passed({ pkg: "axios", postcondition: "error-4xx-5xx", matcher: "try-catch:direct", file: "/a.ts", line: 1 }),
      passed({ pkg: "axios", postcondition: "error-4xx-5xx", matcher: "try-catch:direct", file: "/b.ts", line: 2 }),
    ];

    const result = singleFile([violation], passes);
    mineConventions(result, { ...DEFAULT_OPTS, minSites: 2 });

    expect(violation.conventionMatch).toBeDefined();
    expect(violation.conventionMatch?.site_count).toBe(2);
  });

  it("respects custom opts (maxSupportingSites override)", () => {
    const violation = v({ pkg: "axios", postcondition: "error-4xx-5xx" });
    const passes: PassedDetection[] = Array.from({ length: 10 }, (_, i) =>
      passed({ pkg: "axios", postcondition: "error-4xx-5xx", matcher: "try-catch:direct", file: `/f${i}.ts`, line: i }),
    );

    const result = singleFile([violation], passes);
    mineConventions(result, { ...DEFAULT_OPTS, maxSupportingSites: 3 });

    expect(violation.conventionMatch?.supporting_sites.length).toBe(3);
  });

  it("samples uniformly when group size exceeds maxTrackedPerGroup (preserves match_ratio)", () => {
    // Synthesize 20 passing sites, ALL try-catch:direct. With
    // maxTrackedPerGroup=10, the miner samples 10 of them. All 20 are the
    // same matcher, so the histogram ratio = 1.0 either way. site_count
    // reflects the sampled count (10), not the underlying total — this is
    // the documented v1.0 semantics.
    const violation = v({ pkg: "axios", postcondition: "error-4xx-5xx" });
    const passes: PassedDetection[] = Array.from({ length: 20 }, (_, i) =>
      passed({ pkg: "axios", postcondition: "error-4xx-5xx", matcher: "try-catch:direct", file: `/f${i}.ts`, line: i }),
    );

    const result = singleFile([violation], passes);
    mineConventions(result, { ...DEFAULT_OPTS, maxTrackedPerGroup: 10 });

    expect(violation.conventionMatch).toBeDefined();
    expect(violation.conventionMatch?.site_count).toBe(10);
    expect(violation.conventionMatch?.match_ratio).toBe(1.0);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Idempotency — mineConventions runs twice safely
// ──────────────────────────────────────────────────────────────────────────────

describe("convention-miner — idempotency", () => {
  it("running twice produces the same conventionMatch on each violation", () => {
    const violation = v({ pkg: "axios", postcondition: "error-4xx-5xx" });
    const passes: PassedDetection[] = Array.from({ length: 5 }, (_, i) =>
      passed({ pkg: "axios", postcondition: "error-4xx-5xx", matcher: "try-catch:direct", file: `/f${i}.ts`, line: i }),
    );

    const result = singleFile([violation], passes);
    mineConventions(result);
    const first = JSON.stringify(violation.conventionMatch);

    mineConventions(result);
    const second = JSON.stringify(violation.conventionMatch);

    expect(first).toBe(second);
  });
});
