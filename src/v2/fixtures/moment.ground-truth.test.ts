/**
 * moment Ground-Truth Tests
 *
 * Each SHOULD_FIRE / SHOULD_NOT_FIRE annotation in
 * corpus/packages/moment/fixtures/ground-truth.ts becomes one test case.
 *
 * Postcondition IDs from corpus/packages/moment/contract.yaml:
 *   moment-invalid-date, utc-invalid-date, locale-path-traversal,
 *   parsezone-invalid-date, unix-nan-timestamp, duration-nan-propagation,
 *   definelocale-path-traversal, updatelocale-path-traversal,
 *   format-invalid-date-string, format-redos-unvalidated-input,
 *   toisostring-null-for-invalid
 *
 * Key behaviors under test:
 *   - moment() without isValid() check → SHOULD_FIRE
 *   - moment() with isValid() guard → SHOULD_NOT_FIRE
 *   - moment.locale() with user input → SHOULD_FIRE
 *   - moment.parseZone() without isValid() → SHOULD_FIRE
 *   - moment.unix() without isValid() → SHOULD_FIRE
 *   - moment.format() on invalid moment → SHOULD_FIRE
 *   - Moment.toISOString() without guard → SHOULD_FIRE
 *   - moment.duration() from invalid diff → SHOULD_FIRE
 *
 * Note: moment is synchronous — scanner detects isValid() guard absence,
 * not try-catch absence. Several postconditions require new scanner rules
 * (parseZone, unix, duration, defineLocale, updateLocale, format, toISOString).
 * New SHOULD_FIRE annotations for these will show as "no detector" until
 * scanner upgrade concerns are implemented.
 *
 * Design: spec-driven, NOT based on V1 behavior.
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
  '../../../../nark-corpus/packages/moment/fixtures/ground-truth.ts'
);

const ANNOTATIONS: Annotation[] = parseAnnotations(GROUND_TRUTH_PATH);

describe('moment: ground-truth fixture', () => {
  let result: GroundTruthResult;

  beforeAll(async () => {
    result = await runGroundTruth(GROUND_TRUTH_PATH, CORPUS_PATH, { includeDrafts: true });
  });

  it('analyzer runs without errors', () => {
    expect(result).toBeDefined();
    expect(Array.isArray(result.violations)).toBe(true);
  });

  it('fixture has SHOULD_FIRE and SHOULD_NOT_FIRE annotations', () => {
    expect(ANNOTATIONS.filter(a => a.kind === 'SHOULD_FIRE').length).toBeGreaterThan(0);
    expect(ANNOTATIONS.filter(a => a.kind === 'SHOULD_NOT_FIRE').length).toBeGreaterThan(0);
  });

  for (const ann of ANNOTATIONS.filter(a => a.kind === 'SHOULD_FIRE')) {
    it(`line ${ann.line} should fire ${ann.postconditionId} — ${ann.reason.substring(0, 60)}`, () => {
      const check = assertFires(result.violationsByLine, ann);
      expect(check.passed, check.message).toBe(true);
    });
  }

  for (const ann of ANNOTATIONS.filter(a => a.kind === 'SHOULD_NOT_FIRE')) {
    it(`line ${ann.line} should not fire — ${ann.reason.substring(0, 60)}`, () => {
      const check = assertNotFires(result.violationsByLine, ann);
      expect(check.passed, check.message).toBe(true);
    });
  }
});
