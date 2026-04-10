/**
 * @tanstack/react-query Ground-Truth Tests
 *
 * Each SHOULD_FIRE / SHOULD_NOT_FIRE annotation in
 * corpus/packages/@tanstack/react-query/fixtures/ground-truth.ts becomes one test case.
 *
 * Postcondition IDs from corpus/packages/@tanstack/react-query/contract.yaml:
 *   mutation-error-unhandled: mutateAsync() called without try/catch — rejects when mutationFn throws
 *
 * Key behaviors under test:
 *   - mutation.mutateAsync() without try-catch   → SHOULD_FIRE: mutation-error-unhandled
 *   - mutation.mutateAsync() inside try-catch    → SHOULD_NOT_FIRE
 *   - useQuery() hook (not awaited)              → SHOULD_NOT_FIRE (hooks are not awaited calls)
 *   - useMutation() hook (not awaited)           → SHOULD_NOT_FIRE (hooks are not awaited calls)
 *
 * Note: Most postconditions in this contract relate to React hook patterns
 * (isError checks, error boundaries) which the scanner cannot detect.
 * The only detectable pattern is mutateAsync() — it returns a Promise that can be awaited.
 */

import { describe, it, expect, beforeAll } from "vitest";
import * as path from "path";
import { fileURLToPath } from "url";
import {
  runGroundTruth,
  parseAnnotations,
  assertFires,
  assertNotFires,
  CORPUS_PATH,
} from "./harness.js";
import type { GroundTruthResult, Annotation } from "./harness.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const GROUND_TRUTH_PATH = path.resolve(
  __dirname,
  "../../../../corpus/packages/@tanstack/react-query/fixtures/ground-truth.ts",
);

const ANNOTATIONS: Annotation[] = parseAnnotations(GROUND_TRUTH_PATH);

describe("@tanstack/react-query: ground-truth fixture", () => {
  let result: GroundTruthResult;

  beforeAll(async () => {
    result = await runGroundTruth(GROUND_TRUTH_PATH, CORPUS_PATH);
  });

  it("analyzer runs without errors", () => {
    expect(result).toBeDefined();
    expect(Array.isArray(result.violations)).toBe(true);
  });

  it("fixture has SHOULD_FIRE and SHOULD_NOT_FIRE annotations", () => {
    expect(
      ANNOTATIONS.filter((a) => a.kind === "SHOULD_FIRE").length,
    ).toBeGreaterThan(0);
    expect(
      ANNOTATIONS.filter((a) => a.kind === "SHOULD_NOT_FIRE").length,
    ).toBeGreaterThan(0);
  });

  // One test per SHOULD_FIRE annotation
  for (const ann of ANNOTATIONS.filter((a) => a.kind === "SHOULD_FIRE")) {
    it(`line ${ann.line} should fire ${ann.postconditionId} — ${ann.reason.substring(0, 60)}`, () => {
      const check = assertFires(result.violationsByLine, ann);
      expect(check.passed, check.message).toBe(true);
    });
  }

  // One test per SHOULD_NOT_FIRE annotation
  for (const ann of ANNOTATIONS.filter((a) => a.kind === "SHOULD_NOT_FIRE")) {
    it(`line ${ann.line} should not fire — ${ann.reason.substring(0, 60)}`, () => {
      const check = assertNotFires(result.violationsByLine, ann);
      expect(check.passed, check.message).toBe(true);
    });
  }
});
