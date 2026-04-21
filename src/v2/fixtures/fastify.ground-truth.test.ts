/**
 * fastify Ground-Truth Tests
 *
 * Each SHOULD_FIRE / SHOULD_NOT_FIRE annotation in
 * corpus/packages/fastify/fixtures/ground-truth.ts becomes one test case.
 *
 * Postcondition IDs from corpus/packages/fastify/contract.yaml:
 *   route-handler-async-error     REMOVED (Fastify 5 always catches async handler errors internally)
 *   listen-port-in-use            (app.listen())
 *   close-hook-error              (app.close())
 *   ready-plugin-timeout          (app.ready())
 *   after-error-parameter-unchecked (app.after())
 *
 * Key behaviors under test:
 *   - app.get(async without try-catch)       → SHOULD_NOT_FIRE: route-handler-async-error removed
 *   - app.get(async with try-catch)          → SHOULD_NOT_FIRE
 *   - app.listen() without try-catch         → SHOULD_FIRE: listen-port-in-use
 *   - app.listen() with try-catch            → SHOULD_NOT_FIRE
 *   - app.close() without try-catch          → SHOULD_FIRE: close-websocket-connection-leak
 *   - app.close() with try-catch             → SHOULD_NOT_FIRE
 *   - app.ready() without try-catch          → SHOULD_FIRE: ready-plugin-timeout
 *   - app.ready() with try-catch             → SHOULD_NOT_FIRE
 *   - app.after(() => {}) ignoring err       → SHOULD_FIRE: after-error-parameter-unchecked
 *   - app.after((err) => { if (err) throw }) → SHOULD_NOT_FIRE
 *
 * Design: spec-driven, NOT based on V1 behavior.
 * Note: listen/close/ready/after detection requires scanner upgrade (concern-20260411-fastify-deepen-1).
 * New postconditions may show "no detector" — that is expected per Phase 4 rules.
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
  '../../../../nark-corpus/packages/fastify/fixtures/ground-truth.ts'
);

const ANNOTATIONS: Annotation[] = parseAnnotations(GROUND_TRUTH_PATH);

describe('fastify: ground-truth fixture', () => {
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
