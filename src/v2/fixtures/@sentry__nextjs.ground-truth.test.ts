/**
 * @sentry/nextjs Ground-Truth Tests
 *
 * Each SHOULD_FIRE / SHOULD_NOT_FIRE annotation in
 * nark-corpus-pro/packages/@sentry/nextjs/fixtures/ground-truth.ts becomes one test case.
 *
 * Contracted functions (4 total):
 *   - flush   — can throw on timeout; must be wrapped in try/catch in serverless
 *   - close   — must be awaited and wrapped before process.exit; one-shot SDK disable
 *   - startSpan — re-throws callback errors (transparent propagation)
 *   - wrapApiHandlerWithSentry — re-throws handler errors (NOT detected via dynamic import)
 *
 * Key behaviors under test:
 *   - flush() outside try-catch → SHOULD_FIRE (flush-not-wrapped)
 *   - flush() inside try-catch  → SHOULD_NOT_FIRE
 *   - close() outside try-catch → SHOULD_FIRE (close-not-awaited)
 *   - close() inside try-catch  → SHOULD_NOT_FIRE
 *   - startSpan() without catch → SHOULD_FIRE (span-callback-rethrows)
 *   - startSpan() with catch    → SHOULD_NOT_FIRE
 *
 * Detection strategy: ThrowingFunctionDetectorPlugin — fires when contracted
 * functions are called outside try-catch.
 *
 * Known limitation: wrapApiHandlerWithSentry is not detected when used via
 * dynamic import (await import("@sentry/nextjs")). Static imports would be
 * detected. This is a V2 analyzer limitation for dynamic imports.
 *
 * Corpus: nark-corpus-pro (PRO tier — not nark-corpus public)
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

// Points to nark-corpus-pro, not nark-corpus
const PRO_CORPUS_PATH = path.resolve(__dirname, '../../../../nark-corpus-pro');

const GROUND_TRUTH_PATH = path.resolve(
  __dirname,
  '../../../../nark-corpus-pro/packages/@sentry/nextjs/fixtures/ground-truth.ts'
);

const ANNOTATIONS: Annotation[] = parseAnnotations(GROUND_TRUTH_PATH);

describe('@sentry/nextjs: ground-truth fixture', () => {
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
