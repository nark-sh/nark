/**
 * EventEmitter2 Ground-Truth Tests
 *
 * Each SHOULD_FIRE / SHOULD_NOT_FIRE annotation in
 * nark-corpus/packages/eventemitter2/fixtures/ground-truth.ts becomes one test case.
 *
 * Postcondition IDs from nark-corpus/packages/eventemitter2/contract.yaml:
 *   eventemitter2-001                          — constructor missing .on('error') listener
 *   eventemitter2-emit-unhandled-error         — emit('error') with no listener throws
 *   eventemitter2-emit-async-unhandled-error   — emitAsync('error') with no listener rejects
 *   eventemitter2-emit-async-listener-rejection — listener rejection via Promise.all
 *   eventemitter2-wait-for-timeout             — waitFor() with timeout rejects on expiry
 *   eventemitter2-wait-for-cancel              — waitFor() cancel() rejects
 *   eventemitter2-static-once-error-rejection  — EventEmitter2.once() rejects on error event
 *   eventemitter2-static-once-timeout          — EventEmitter2.once() with timeout rejects
 *   eventemitter2-listen-to-invalid-target     — listenTo() throws on invalid target
 *
 * Key behaviors under test:
 *   - new EventEmitter2() without .on('error') → eventemitter2-001 (EventListenerAbsencePlugin)
 *   - emit('error') without listener → eventemitter2-emit-unhandled-error
 *   - await emitAsync() without try-catch → eventemitter2-emit-async-* (ThrowingFunctionDetector)
 *   - await waitFor(..., {timeout}) without try-catch → eventemitter2-wait-for-timeout
 *   - await EventEmitter2.once() without try-catch → eventemitter2-static-once-*
 *   - listenTo(null) → eventemitter2-listen-to-invalid-target
 *
 * Design: spec-driven, NOT based on V1 behavior.
 * Note: Many new postconditions require scanner rules not yet implemented.
 *       Tests will show "no violations found" until bc-scanner-upgrade implements detectors.
 *       The fixture compiles and runs without crashing — the test structure is ready.
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
  '../../../../nark-corpus/packages/eventemitter2/fixtures/ground-truth.ts'
);

const ANNOTATIONS: Annotation[] = parseAnnotations(GROUND_TRUTH_PATH);

describe('eventemitter2: ground-truth fixture', () => {
  let result: GroundTruthResult;

  beforeAll(async () => {
    result = await runGroundTruth(GROUND_TRUTH_PATH, CORPUS_PATH);
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
