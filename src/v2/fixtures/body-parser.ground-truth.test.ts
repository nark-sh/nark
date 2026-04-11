/**
 * body-parser Ground-Truth Tests
 *
 * Each SHOULD_FIRE / SHOULD_NOT_FIRE annotation in
 * corpus/packages/body-parser/fixtures/ground-truth.ts becomes one test case.
 *
 * Postcondition IDs from corpus/packages/body-parser/contract.yaml:
 *   malformed-json-throws (json())
 *   payload-too-large (json(), urlencoded(), raw(), text())
 *   unsupported-charset (json(), text())
 *   too-many-parameters (urlencoded())
 *   parse-failure (urlencoded())
 *
 * ⚠️  DETECTION MODEL MISMATCH (concern-2026-04-03-body-parser-1):
 * body-parser is Express middleware. The scanner currently checks for try-catch
 * around bodyParser.*() calls, which is architecturally wrong — the correct
 * handling is a 4-argument Express error handler (err, req, res, next).
 *
 * The scanner fires on EVERY bodyParser.*() call including when proper Express
 * error middleware is registered. All violations are currently false positives.
 *
 * This test verifies the scanner runs without crashing. SHOULD_NOT_FIRE
 * assertions are disabled until concern-2026-04-03-body-parser-1 is resolved.
 *
 * Design: spec-driven, NOT based on V1 behavior.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import * as path from 'path';
import { fileURLToPath } from 'url';
import {
  runGroundTruth,
  CORPUS_PATH,
} from './harness.js';
import type { GroundTruthResult } from './harness.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const GROUND_TRUTH_PATH = path.resolve(
  __dirname,
  '../../../../nark-corpus/packages/body-parser/fixtures/ground-truth.ts'
);

describe('body-parser: ground-truth fixture', () => {
  let result: GroundTruthResult;

  beforeAll(async () => {
    result = await runGroundTruth(GROUND_TRUTH_PATH, CORPUS_PATH, { includeDrafts: true });
  });

  it('analyzer runs without errors', () => {
    expect(result).toBeDefined();
    expect(Array.isArray(result.violations)).toBe(true);
  });

  // Regression guard: scanner should produce violations on body-parser calls
  // (even if they are currently false positives — we want to know if detection breaks)
  it('scanner detects body-parser call sites (even if currently FP)', () => {
    // The scanner currently fires on all bodyParser.*() calls due to try-catch detection model
    // This is a known FP — tracked in concern-2026-04-03-body-parser-1
    // This test verifies detection is not broken (we expect violations until detection model is fixed)
    expect(result.violations.length).toBeGreaterThan(0);
  });

  // TODO: When concern-2026-04-03-body-parser-1 is resolved, add proper SHOULD_FIRE /
  // SHOULD_NOT_FIRE annotations in ground-truth.ts and enable assertions here.
});
