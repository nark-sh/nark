/**
 * archiver Ground-Truth Tests
 *
 * Each SHOULD_FIRE / SHOULD_NOT_FIRE annotation in
 * corpus/packages/archiver/fixtures/ground-truth.ts becomes one test case.
 *
 * Postcondition IDs from corpus/packages/archiver/contract.yaml:
 *   missing-error-handler, missing-warning-handler,
 *   finalize-incomplete-output (new, needs scanner rule),
 *   append-stream-error-not-propagated (new, needs scanner rule),
 *   symlink-zip-format-unsupported (new, needs scanner rule)
 *
 * Key behaviors under test:
 *   - archiver() without error handler → SHOULD_FIRE (missing-error-handler)
 *   - archiver() without warning handler → SHOULD_FIRE (missing-warning-handler)
 *   - await archive.finalize() without close event wait → SHOULD_FIRE (finalize-incomplete-output)
 *   - stream passed to append() without error handler → SHOULD_FIRE (append-stream-error-not-propagated)
 *   - symlink() called on zip-format archive → SHOULD_FIRE (symlink-zip-format-unsupported)
 *   - All patterns properly handled → SHOULD_NOT_FIRE
 *
 * Note: archiver uses event-driven error propagation (no try-catch). Scanner
 * detects event listener absence via EventListenerAnalyzer. New postconditions
 * for finalize-incomplete-output, append-stream-error-not-propagated, and
 * symlink-zip-format-unsupported require new scanner upgrade concerns to implement
 * detection — SHOULD_FIRE tests for these may show "no detector" until resolved.
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
  '../../../../nark-corpus/packages/archiver/fixtures/ground-truth.ts'
);

const ANNOTATIONS: Annotation[] = parseAnnotations(GROUND_TRUTH_PATH);

describe('archiver: ground-truth fixture', () => {
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
