/**
 * @sentry/node Ground-Truth Tests
 *
 * Each SHOULD_FIRE / SHOULD_NOT_FIRE annotation in
 * nark-corpus/packages/@sentry/node/fixtures/ground-truth.ts becomes one test case.
 *
 * Postconditions under test (from nark-corpus/packages/@sentry/node/contract.yaml):
 *   - span-manual-finish-never-called   startSpanManual callback lacks try/finally with finish/span.end
 *   - span-manual-callback-rethrows     startSpanManual outside try-catch (re-throws callback errors)
 *   - inactive-span-end-never-called    startInactiveSpan — no try/finally with span.end in scope
 *   - monitor-callback-rethrows         withMonitor outside try-catch (re-throws callback errors)
 *   - monitor-slug-not-configured       withMonitor called without upsertMonitorConfig (3rd arg)
 *
 * Detection logic:
 *   - startSpanManual: ThrowingFunctionDetector fires the call; contract-matcher checks
 *     span-manual-finish-never-called by inspecting the callback for try/finally with
 *     finish()/span.end(). span-manual-callback-rethrows uses standard try-catch check.
 *   - startInactiveSpan: ThrowingFunctionDetector fires the call; contract-matcher checks
 *     inactive-span-end-never-called by scanning the enclosing function for a finally
 *     block containing .end().
 *   - withMonitor: ThrowingFunctionDetector fires the call; contract-matcher fires
 *     monitor-slug-not-configured when arg count < 3 regardless of try-catch,
 *     and monitor-callback-rethrows via standard try-catch check.
 *
 * Evidence: concern-20260611-sentry-node-deepen-1 through -3
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
  '../../../../nark-corpus/packages/@sentry/node/fixtures/ground-truth.ts'
);

const ANNOTATIONS: Annotation[] = parseAnnotations(GROUND_TRUTH_PATH);

describe('@sentry/node: ground-truth fixture', () => {
  let result: GroundTruthResult;

  beforeAll(async () => {
    result = await runGroundTruth(GROUND_TRUTH_PATH, CORPUS_PATH, {
      includeDrafts: true,
      packageName: '@sentry/node',
    });
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
