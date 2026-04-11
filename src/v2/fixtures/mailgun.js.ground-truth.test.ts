/**
 * mailgun.js Ground-Truth Tests
 *
 * Each SHOULD_FIRE / SHOULD_NOT_FIRE annotation in
 * corpus/packages/mailgun.js/fixtures/ground-truth.ts becomes one test case.
 *
 * Postcondition IDs from corpus/packages/mailgun.js/contract.yaml:
 *   mailgun-api-error (one contracted function: create)
 *
 * Key behaviors under test:
 *   - mg.messages.create() without try-catch → SHOULD_FIRE: mailgun-api-error
 *   - mg.messages.create() inside try-catch  → SHOULD_NOT_FIRE
 *   - this.mg.messages.create() in class method → SHOULD_FIRE (no try-catch)
 *   - mg.messages.create() with .catch() handler → SHOULD_NOT_FIRE
 *
 * Detection: IMailgunClient type annotation → InstanceTracker → PropertyChainDetector
 * mg.messages.create() detected as 2-level property chain on a mailgun.js typed instance.
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
  '../../../../nark-corpus/packages/mailgun.js/fixtures/ground-truth.ts'
);

const ANNOTATIONS: Annotation[] = parseAnnotations(GROUND_TRUTH_PATH);

describe('mailgun.js: ground-truth fixture', () => {
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
    it(`line ${ann.line}: SHOULD_FIRE [${ann.postconditionId}] — ${ann.reason}`, () => {
      const check = assertFires(result.violationsByLine, ann);
      expect(check.passed, check.message).toBe(true);
    });
  }

  // One test per SHOULD_NOT_FIRE annotation
  for (const ann of ANNOTATIONS.filter(a => a.kind === 'SHOULD_NOT_FIRE')) {
    it(`line ${ann.line}: SHOULD_NOT_FIRE — ${ann.reason}`, () => {
      const check = assertNotFires(result.violationsByLine, ann);
      expect(check.passed, check.message).toBe(true);
    });
  }
});
