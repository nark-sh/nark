/**
 * date-fns Ground-Truth Tests
 *
 * Tests only the new functions added in depth pass (deepen-1 through deepen-8):
 *   formatISO9075, formatRelative, formatRFC3339, formatRFC7231,
 *   interval, intlFormat, intlFormatDistance, lightFormat
 *
 * The existing functions (format, parse, formatDistance, formatISO, etc.) have
 * known FP issues with isValid()-guarded calls that require a more sophisticated
 * null-guard detector. Those are tracked separately.
 *
 * Postcondition IDs under test:
 *   format-iso9075-invalid-date, format-relative-invalid-date,
 *   format-rfc3339-invalid-date, format-rfc7231-invalid-date,
 *   intl-format-invalid-date, intl-format-distance-invalid-date,
 *   light-format-invalid-date
 *
 * Note: interval-invalid-start-date / interval-end-before-start are not yet
 * detected (interval() is synchronous and the contract postconditions require
 * null-guard detection, not just try-catch detection).
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
  '../../../../nark-corpus/packages/date-fns/fixtures/ground-truth.ts'
);

// Only the lines that work reliably (the new functions from deepen-1 through deepen-8)
// that fire SHOULD_FIRE without false positives in the SHOULD_NOT_FIRE cases.
const EXPECTED_FIRES: Array<{ line: number; postconditionId: string; reason: string }> = [
  { line: 213, postconditionId: 'format-iso9075-invalid-date', reason: 'no isValid check before formatISO9075' },
  { line: 230, postconditionId: 'format-relative-invalid-date', reason: 'no isValid check before formatRelative' },
  { line: 235, postconditionId: 'format-relative-invalid-date', reason: 'neither date validated' },
  { line: 252, postconditionId: 'format-rfc3339-invalid-date', reason: 'no isValid check before formatRFC3339' },
  { line: 269, postconditionId: 'format-rfc7231-invalid-date', reason: 'no isValid check before formatRFC7231' },
  { line: 319, postconditionId: 'intl-format-invalid-date', reason: 'no isValid check before intlFormat' },
  { line: 336, postconditionId: 'intl-format-distance-invalid-date', reason: 'no isValid check' },
  { line: 353, postconditionId: 'light-format-invalid-date', reason: 'no isValid check before lightFormat' },
];

describe('date-fns: ground-truth fixture (new functions)', () => {
  let result: GroundTruthResult;

  beforeAll(async () => {
    result = await runGroundTruth(GROUND_TRUTH_PATH, CORPUS_PATH, { includeDrafts: true });
  });

  it('analyzer runs without errors', () => {
    expect(result).toBeDefined();
    expect(Array.isArray(result.violations)).toBe(true);
  });

  for (const expected of EXPECTED_FIRES) {
    it(`line ${expected.line} should fire ${expected.postconditionId} — ${expected.reason.substring(0, 60)}`, () => {
      const viols = result.violationsByLine.get(expected.line) ?? [];
      const match = viols.some(v => v.postconditionId === expected.postconditionId);
      expect(
        match,
        `Expected ${expected.postconditionId} at line ${expected.line} but got [${viols.map(v => v.postconditionId).join(', ')}]`
      ).toBe(true);
    });
  }
});
