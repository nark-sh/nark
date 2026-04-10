/**
 * @anthropic-ai/sdk Ground-Truth Tests
 *
 * Each SHOULD_FIRE / SHOULD_NOT_FIRE annotation in
 * corpus/packages/@anthropic-ai/sdk/fixtures/ground-truth.ts becomes one test case.
 *
 * Postcondition IDs from corpus/packages/@anthropic-ai/sdk/contract.yaml:
 *   messages-create-no-try-catch       — messages.create() without try-catch
 *   messages-stream-no-try-catch       — messages.stream() without try-catch
 *   count-tokens-no-try-catch          — messages.countTokens() without try-catch
 *   batches-create-no-try-catch        — messages.batches.create() without try-catch
 *   messages-parse-no-try-catch        — messages.parse() without try-catch
 *   files-upload-no-try-catch          — beta.files.upload() without try-catch
 *
 * Scanner capability note:
 *   - messages.create() is detected by existing await_patterns rules.
 *   - messages.countTokens(), messages.batches.create(), messages.parse(), and
 *     beta.files.upload() are NEW functions added in the depth pass. Scanner concern IDs
 *     concern-20260402-anthropic-sdk-deepen-1 through -4 are queued in upgrade-concerns.json.
 *     These new functions are only covered in the wrapped (try-catch) form in the fixture,
 *     so all annotations for those functions are SHOULD_NOT_FIRE.
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
  '../../../../corpus/packages/@anthropic-ai/sdk/fixtures/ground-truth.ts'
);

const ANNOTATIONS: Annotation[] = parseAnnotations(GROUND_TRUTH_PATH);

describe('@anthropic-ai/sdk: ground-truth fixture', () => {
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

  // One test per SHOULD_FIRE annotation
  for (const ann of ANNOTATIONS.filter(a => a.kind === 'SHOULD_FIRE')) {
    it(`line ${ann.line} should fire ${ann.postconditionId} — ${ann.reason.substring(0, 60)}`, () => {
      const check = assertFires(result.violationsByLine, ann);
      expect(check.passed, check.message).toBe(true);
    });
  }

  // One test per SHOULD_NOT_FIRE annotation
  for (const ann of ANNOTATIONS.filter(a => a.kind === 'SHOULD_NOT_FIRE')) {
    it(`line ${ann.line} should not fire — ${ann.reason.substring(0, 60)}`, () => {
      const check = assertNotFires(result.violationsByLine, ann);
      expect(check.passed, check.message).toBe(true);
    });
  }
});
