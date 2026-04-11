/**
 * @mistralai/mistralai Ground-Truth Tests
 *
 * Each SHOULD_FIRE / SHOULD_NOT_FIRE annotation in
 * corpus/packages/@mistralai/mistralai/fixtures/ground-truth.ts becomes one test case.
 *
 * Postcondition IDs from corpus/packages/@mistralai/mistralai/contract.yaml:
 *   complete-no-error-handling
 *   stream-no-error-handling
 *
 * Key behaviors under test:
 *   - client.chat.complete() without try-catch → SHOULD_FIRE: complete-no-error-handling
 *   - client.chat.stream() without try-catch → SHOULD_FIRE: stream-no-error-handling
 *   - Both WITH try-catch → SHOULD_NOT_FIRE
 *   - Both WITH .catch() chain → SHOULD_NOT_FIRE (as used by cline)
 *
 * Detection: PropertyChainDetector handles 2-level chains (client.chat.complete(),
 * client.chat.stream()). The Mistral class is tracked via class_names: ["Mistral"].
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
  '../../../../nark-corpus/packages/@mistralai/mistralai/fixtures/ground-truth.ts'
);

const ANNOTATIONS: Annotation[] = parseAnnotations(GROUND_TRUTH_PATH);

describe('@mistralai/mistralai: ground-truth fixture', () => {
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
