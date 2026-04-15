/**
 * @tanstack/react-router Ground-Truth Tests
 *
 * Each SHOULD_FIRE / SHOULD_NOT_FIRE annotation in
 * nark-corpus/packages/@tanstack/react-router/fixtures/ground-truth.ts becomes one test case.
 *
 * Postcondition IDs from nark-corpus/packages/@tanstack/react-router/contract.yaml:
 *   blocker-shouldblock-fn-uncaught-rejection: async shouldBlockFn rejects without try-catch
 *   blocker-external-navigation-bypass: multiple blockers, one throws before others run
 *   awaited-deferred-rejection-no-error-boundary: deferred promise rejection without error boundary
 *   awaited-missing-suspense-boundary: useAwaited with pending promise and no Suspense boundary
 *   lazy-route-component-import-failure: dynamic import fails due to network/path error
 *   lazy-route-component-chunk-hash-mismatch-loop: chunk hash mismatch after deploy
 *   loader-deps-route-mismatch-strict: strict: true with wrong 'from' parameter
 *   router-provider-loader-initialization-error: root loader throws with no error boundary
 *   router-provider-missing-context: TanStack Router hook used outside RouterProvider
 *
 * Key behaviors under test:
 *   Most postconditions in this contract relate to React hook patterns, Suspense boundaries,
 *   and error boundary requirements which the V2 scanner does not currently detect.
 *   The ground-truth test validates that the analyzer runs without crashing on this fixture.
 *   SHOULD_FIRE annotations will be added when scanner detection rules are implemented.
 *
 * Note on scanner detection:
 *   @tanstack/react-router contracts focus on React component lifecycle patterns
 *   (Suspense, ErrorBoundary, async shouldBlockFn). These require React-aware analysis
 *   that the current scanner does not implement. Scanner detection is tracked in
 *   upgrade-concerns.json (concerns 1-5 for this package).
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
  "../../../../nark-corpus/packages/@tanstack/react-router/fixtures/ground-truth.ts",
);

const ANNOTATIONS: Annotation[] = parseAnnotations(GROUND_TRUTH_PATH);

describe("@tanstack/react-router: ground-truth fixture", () => {
  let result: GroundTruthResult;

  beforeAll(async () => {
    result = await runGroundTruth(GROUND_TRUTH_PATH, CORPUS_PATH);
  });

  it("analyzer runs without errors", () => {
    expect(result).toBeDefined();
    expect(Array.isArray(result.violations)).toBe(true);
  });

  it("fixture file is parseable", () => {
    // Fixture uses @expect-violation / @expect-clean annotations (older format)
    // SHOULD_FIRE / SHOULD_NOT_FIRE annotations will be added when scanner detection rules exist
    expect(ANNOTATIONS).toBeDefined();
    expect(Array.isArray(ANNOTATIONS)).toBe(true);
  });

  // One test per SHOULD_FIRE annotation (will be populated when scanner rules added)
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
