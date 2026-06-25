/**
 * Detection Trace — Wave 0 RED tests.
 *
 * These tests author the acceptance criteria for the upcoming
 * `Violation.detectionTrace` field that Wave 1 will introduce. They run
 * against the existing analyzer pipeline and therefore CURRENTLY FAIL —
 * the assertion path reaches `result.violations[i].detectionTrace` which
 * does not exist on the Violation type yet. That is the RED signal.
 *
 * Acceptance:
 *   PH1-R2  — every Violation emitted by the analyzer has a non-empty
 *             `detectionTrace` array.
 *   PH1-R2a — postcondition-gated matchers (framework-specific) appear as
 *             `not_applicable` not `failed` for unrelated postconditions.
 *   PH1-R2b — `Sentry.startSpanManual(...)` wrapped in a try/catch but
 *             missing `span.end()` in finally MUST mark TRY_CATCH_DIRECT
 *             as `not_applicable` (NOT `passed`) — Pitfall 7 in RESEARCH.
 *
 * The `@ts-expect-error` annotations are intentional and document the
 * exact shape Wave 1 will add. When Wave 1 adds the field, vitest flips
 * these tests from RED to GREEN and TypeScript drops the suppressions.
 */

import { describe, it, expect, beforeAll } from "vitest";
import * as path from "path";
import { fileURLToPath } from "url";
import { runGroundTruth, CORPUS_PATH } from "./harness.js";
import type { GroundTruthResult } from "./harness.js";
import type { Violation } from "../types/index.js";
import {
  MATCHER_IDS,
  applicabilityPredicate,
} from "../matchers/registry.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Reuse the existing axios + sentry/node fixtures. Both have call sites
// that the V2 analyzer flags today.
const AXIOS_GROUND_TRUTH = path.resolve(
  __dirname,
  "../../../../nark-corpus/packages/axios/fixtures/ground-truth.ts",
);
const SENTRY_GROUND_TRUTH = path.resolve(
  __dirname,
  "../../../../nark-corpus/packages/@sentry/node/fixtures/ground-truth.ts",
);

// ──────────────────────────────────────────────────────────────────────────────
// Shape contract used by all three tests.
// ──────────────────────────────────────────────────────────────────────────────

interface TraceEntry {
  matcher: string;
  status: "passed" | "failed" | "not_applicable";
  reason?: string;
}

function readTrace(violation: Violation): TraceEntry[] | undefined {
  // @ts-expect-error Wave 1 adds the `detectionTrace` field to Violation.
  return violation.detectionTrace as TraceEntry[] | undefined;
}

// ──────────────────────────────────────────────────────────────────────────────
// PH1-R2: every Violation carries a non-empty detectionTrace[].
// ──────────────────────────────────────────────────────────────────────────────

describe("detection-trace: PH1-R2 — Violation.detectionTrace exists", () => {
  let result: GroundTruthResult;

  beforeAll(async () => {
    result = await runGroundTruth(AXIOS_GROUND_TRUTH, CORPUS_PATH);
  });

  it("axios fixture produces at least one violation (sanity)", () => {
    expect(result.violations.length).toBeGreaterThan(0);
  });

  it("every violation has a non-empty detectionTrace array (RED until Wave 1)", () => {
    for (const v of result.violations) {
      const trace = readTrace(v);
      expect(
        trace,
        `expected detectionTrace on violation ${v.package}:${v.postconditionId}@${v.line} (Wave 1 adds the field)`,
      ).toBeDefined();
      expect(Array.isArray(trace)).toBe(true);
      expect((trace as TraceEntry[]).length).toBeGreaterThan(0);
      for (const entry of trace as TraceEntry[]) {
        expect(entry).toHaveProperty("matcher");
        expect(entry).toHaveProperty("status");
        expect(["passed", "failed", "not_applicable"]).toContain(entry.status);
      }
    }
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// PH1-R2a: framework-gated matchers surface as `not_applicable`, not `failed`.
// ──────────────────────────────────────────────────────────────────────────────

describe("detection-trace: PH1-R2a — gated matchers are not_applicable", () => {
  let result: GroundTruthResult;

  beforeAll(async () => {
    result = await runGroundTruth(AXIOS_GROUND_TRUTH, CORPUS_PATH);
  });

  it("registry says express-async-errors matcher does NOT apply to axios", () => {
    // Sanity-check the registry contract that the trace finalizer will rely on.
    const applies = applicabilityPredicate(
      MATCHER_IDS.FRAMEWORK_EXPRESS_ASYNC_ERRORS,
      { packageName: "axios", postconditionId: "error-4xx-5xx" },
    );
    expect(applies).toBe(false);
  });

  it("axios violation marks FRAMEWORK_EXPRESS_ASYNC_ERRORS as not_applicable (RED until Wave 1)", () => {
    expect(result.violations.length).toBeGreaterThan(0);
    const v = result.violations[0];
    const trace = readTrace(v);

    expect(
      trace,
      "Wave 1 must populate detectionTrace including not_applicable entries for gated matchers",
    ).toBeDefined();

    const entry = (trace as TraceEntry[]).find(
      (e) => e.matcher === MATCHER_IDS.FRAMEWORK_EXPRESS_ASYNC_ERRORS,
    );
    expect(
      entry,
      `expected a trace entry for ${MATCHER_IDS.FRAMEWORK_EXPRESS_ASYNC_ERRORS}`,
    ).toBeDefined();
    expect(entry?.status).toBe("not_applicable");
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// PH1-R2b: TRY_CATCH_DIRECT must be `not_applicable` for sentry span-lifecycle.
// (Pitfall 7 — a try/catch wrapper does NOT excuse missing span.end()).
// ──────────────────────────────────────────────────────────────────────────────

describe("detection-trace: PH1-R2b — Pitfall 7 sentry span lifecycle", () => {
  let result: GroundTruthResult;

  beforeAll(async () => {
    result = await runGroundTruth(SENTRY_GROUND_TRUTH, CORPUS_PATH, {
      packageName: "@sentry/node",
    });
  });

  it("registry gates TRY_CATCH_DIRECT off for @sentry/node span-lifecycle postconditions", () => {
    const applies = applicabilityPredicate(MATCHER_IDS.TRY_CATCH_DIRECT, {
      packageName: "@sentry/node",
      postconditionId: "span-manual-finish-never-called",
    });
    expect(applies).toBe(false);
  });

  it("sentry violation does NOT report TRY_CATCH_DIRECT as passed (RED until Wave 1)", () => {
    const spanViols = result.violations.filter((v) =>
      /span-manual-finish-never-called|inactive-span-end-never-called/.test(
        v.postconditionId,
      ),
    );
    expect(
      spanViols.length,
      "expected at least one sentry span-lifecycle violation from the fixture",
    ).toBeGreaterThan(0);

    for (const v of spanViols) {
      const trace = readTrace(v);
      expect(
        trace,
        `expected detectionTrace on sentry violation ${v.postconditionId}@${v.line}`,
      ).toBeDefined();

      const tryCatchEntry = (trace as TraceEntry[]).find(
        (e) => e.matcher === MATCHER_IDS.TRY_CATCH_DIRECT,
      );
      // The matcher MAY be omitted, OR it MUST be not_applicable. Either way
      // it MUST NOT be reported as `passed` — Pitfall 7 from RESEARCH.
      if (tryCatchEntry) {
        expect(tryCatchEntry.status).toBe("not_applicable");
      }
    }
  });
});
