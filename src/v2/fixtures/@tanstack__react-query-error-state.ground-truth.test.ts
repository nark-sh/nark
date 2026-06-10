/**
 * @tanstack/react-query Ground-Truth Tests — error-state-handled cases
 *
 * Separate from @tanstack__react-query.ground-truth.test.ts so the file-level
 * { error / isError markers in this fixture don't suppress the SHOULD_FIRE
 * cases in the main ground-truth.ts fixture.
 *
 * Covers wave-1 FP suppressions for:
 *   - stale-query-refetch-error (useQuery with { error } / isError destructured)
 *   - mutation-optimistic-update-rollback (useMutation with { error } destructured)
 */

import { describe, it, expect, beforeAll } from 'vitest';
import * as path from 'path';
import { fileURLToPath } from 'url';
import {
  runGroundTruth,
  parseAnnotations,
  assertFires,
  assertNotFires,
  CORPUS_PATH,
} from './harness.js';
import type { GroundTruthResult, Annotation } from './harness.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const GROUND_TRUTH_PATH = path.resolve(
  __dirname,
  '../../../../nark-corpus/packages/@tanstack/react-query/fixtures/ground-truth-error-state.ts',
);

const ANNOTATIONS: Annotation[] = parseAnnotations(GROUND_TRUTH_PATH);

describe('@tanstack/react-query: ground-truth-error-state fixture', () => {
  let result: GroundTruthResult;

  beforeAll(async () => {
    result = await runGroundTruth(GROUND_TRUTH_PATH, CORPUS_PATH);
  });

  it('analyzer runs without errors', () => {
    expect(result).toBeDefined();
    expect(Array.isArray(result.violations)).toBe(true);
  });

  it('fixture has SHOULD_NOT_FIRE annotations', () => {
    expect(
      ANNOTATIONS.filter((a) => a.kind === 'SHOULD_NOT_FIRE').length,
    ).toBeGreaterThan(0);
  });

  for (const ann of ANNOTATIONS.filter((a) => a.kind === 'SHOULD_FIRE')) {
    it(`line ${ann.line} should fire ${ann.postconditionId} — ${ann.reason.substring(0, 60)}`, () => {
      const check = assertFires(result.violationsByLine, ann);
      expect(check.passed, check.message).toBe(true);
    });
  }

  for (const ann of ANNOTATIONS.filter((a) => a.kind === 'SHOULD_NOT_FIRE')) {
    it(`line ${ann.line} should not fire — ${ann.reason.substring(0, 60)}`, () => {
      const check = assertNotFires(result.violationsByLine, ann);
      expect(check.passed, check.message).toBe(true);
    });
  }
});
