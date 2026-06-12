/**
 * @nestjs/event-emitter Ground-Truth Tests
 *
 * Each SHOULD_FIRE / SHOULD_NOT_FIRE annotation in
 * nark-corpus-pro/packages/@nestjs/event-emitter/fixtures/ground-truth.ts becomes
 * one test case.
 *
 * Contracted async surface (4 postconditions):
 *   nestjs-event-emitter-emit-async-rejection       — await eventEmitter.emitAsync(...)
 *   nestjs-event-emitter-wait-for-rejection         — await eventEmitter.waitFor(...)
 *   nestjs-event-emitter-once-rejection             — await EventEmitter2.once(...)
 *   nestjs-event-emitter-wait-until-ready-rejection — await watcher.waitUntilReady()
 *
 * Detection strategy: PropertyChainDetectorPlugin (depth-2) on EventEmitter2 +
 * EventEmitterReadinessWatcher instances tracked via DI constructor parameter
 * type annotations (NestJS pattern: `constructor(private eventEmitter:
 * EventEmitter2)`). The static EventEmitter2.once(...) call is detected via the
 * EventEmitter2 class identifier.
 *
 * Corpus: nark-corpus-pro (PRO tier — new contracts stage in pro per 2026-06-11
 * multi-corpus policy).
 */

import { describe, it, expect, beforeAll } from 'vitest';
import * as path from 'path';
import { fileURLToPath } from 'url';
import {
  runGroundTruth,
  parseAnnotations,
  assertFires,
  assertNotFires,
} from './harness.js';
import type { GroundTruthResult, Annotation } from './harness.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Points to nark-corpus-pro (PRO tier), not nark-corpus
const PRO_CORPUS_PATH = path.resolve(__dirname, '../../../../nark-corpus-pro');

const GROUND_TRUTH_PATH = path.resolve(
  __dirname,
  '../../../../nark-corpus-pro/packages/@nestjs/event-emitter/fixtures/ground-truth.ts'
);

const ANNOTATIONS: Annotation[] = parseAnnotations(GROUND_TRUTH_PATH);

describe('@nestjs/event-emitter: ground-truth fixture', () => {
  let result: GroundTruthResult;

  beforeAll(async () => {
    result = await runGroundTruth(GROUND_TRUTH_PATH, PRO_CORPUS_PATH, { includeDrafts: true });
  });

  it('analyzer runs without errors', () => {
    expect(result).toBeDefined();
    expect(Array.isArray(result.violations)).toBe(true);
  });

  it('fixture has SHOULD_FIRE and SHOULD_NOT_FIRE annotations', () => {
    expect(ANNOTATIONS.filter((a: Annotation) => a.kind === 'SHOULD_FIRE').length).toBeGreaterThan(0);
    expect(ANNOTATIONS.filter((a: Annotation) => a.kind === 'SHOULD_NOT_FIRE').length).toBeGreaterThan(0);
  });

  for (const ann of ANNOTATIONS.filter((a: Annotation) => a.kind === 'SHOULD_FIRE')) {
    it(`line ${ann.line} should fire ${ann.postconditionId} — ${ann.reason.substring(0, 60)}`, () => {
      const check = assertFires(result.violationsByLine, ann);
      expect(check.passed, check.message).toBe(true);
    });
  }

  for (const ann of ANNOTATIONS.filter((a: Annotation) => a.kind === 'SHOULD_NOT_FIRE')) {
    it(`line ${ann.line} should not fire — ${ann.reason.substring(0, 60)}`, () => {
      const check = assertNotFires(result.violationsByLine, ann);
      expect(check.passed, check.message).toBe(true);
    });
  }
});
