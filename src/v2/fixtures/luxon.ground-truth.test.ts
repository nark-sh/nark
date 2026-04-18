/**
 * Luxon Ground-Truth Tests
 *
 * Tests that the V2 scanner fires on every @expect-violation call site
 * in nark-corpus/packages/luxon/fixtures/ground-truth.ts, and does NOT
 * fire on @expect-clean call sites.
 *
 * Postcondition IDs from nark-corpus/packages/luxon/contract.yaml:
 *   frommillis-non-number-throws       (DateTime.fromMillis)
 *   fromseconds-non-number-throws      (DateTime.fromSeconds)
 *   fromobject-conflicting-specification (DateTime.fromObject)
 *   fromformat-missing-args            (DateTime.fromFormat)
 *   startof-invalid-unit               (DateTime.startOf)
 *   endof-invalid-unit                 (DateTime.endOf)
 *   min-non-datetime-throws            (DateTime.min)
 *   max-non-datetime-throws            (DateTime.max)
 *
 * Note: The ground-truth fixture uses @expect-violation / @expect-clean
 * annotations (corpus convention). This test file directly maps known
 * violation call-site line numbers to expected postcondition IDs.
 * Line numbers are stable — changes to ground-truth.ts must update this
 * test accordingly.
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
  '../../../../nark-corpus/packages/luxon/fixtures/ground-truth.ts'
);

// ─── Known violation call-site line numbers ────────────────────────────────
//
// These match the @expect-violation blocks in ground-truth.ts.
// Each entry: { line, postconditionId }
//
// To update: re-run the scanner against ground-truth.ts and update lines.
// Command: node dist/index.js --tsconfig <fixturedir>/__gt-tsconfig.json --corpus ../nark-corpus

const EXPECTED_VIOLATIONS: { line: number; postconditionId: string; label: string }[] = [
  { line: 29,  postconditionId: 'frommillis-non-number-throws',        label: 'fromMillis — no try-catch' },
  { line: 69,  postconditionId: 'fromseconds-non-number-throws',       label: 'fromSeconds — no try-catch' },
  { line: 95,  postconditionId: 'fromobject-conflicting-specification', label: 'fromObject — weekYear+month mix' },
  { line: 101, postconditionId: 'fromobject-conflicting-specification', label: 'fromObject — ordinal+month mix' },
  { line: 131, postconditionId: 'fromformat-missing-args',             label: 'fromFormat — undefined format arg' },
  { line: 155, postconditionId: 'startof-invalid-unit',                label: 'startOf — dynamic unit, no validation' },
  { line: 189, postconditionId: 'endof-invalid-unit',                  label: 'endOf — dynamic unit, no validation' },
  { line: 209, postconditionId: 'min-non-datetime-throws',             label: 'min — non-DateTime args' },
  { line: 235, postconditionId: 'max-non-datetime-throws',             label: 'max — non-DateTime args' },
];

// Lines expected to be clean (no error-level violations).
// These are the call sites inside @expect-clean functions.
const EXPECTED_CLEAN_LINES: { line: number; label: string }[] = [
  { line: 41,  label: 'fromMillis inside try-catch (validated)' },
  { line: 54,  label: 'fromMillis inside try-catch (direct)' },
  { line: 80,  label: 'fromSeconds inside try-catch (validated)' },
  { line: 107, label: 'fromObject — Gregorian only, try-catch' },
  { line: 117, label: 'fromObject — week date only, try-catch' },
  { line: 140, label: 'fromFormat — validated args, try-catch' },
  { line: 165, label: 'startOf — validated unit, try-catch' },
  { line: 175, label: 'startOf — hardcoded valid unit, try-catch' },
  { line: 195, label: 'endOf — hardcoded valid unit, try-catch' },
  { line: 221, label: 'min — all DateTime instances, try-catch' },
  { line: 244, label: 'max — both DateTime instances, try-catch' },
];

// ─── Test suite ────────────────────────────────────────────────────────────

describe('luxon: ground-truth fixture', () => {
  let result: GroundTruthResult;

  beforeAll(async () => {
    result = await runGroundTruth(GROUND_TRUTH_PATH, CORPUS_PATH, { includeDrafts: true });
  });

  it('analyzer runs without errors', () => {
    expect(result).toBeDefined();
    expect(Array.isArray(result.violations)).toBe(true);
  });

  // SHOULD_FIRE: each @expect-violation call site must produce the expected violation
  for (const expected of EXPECTED_VIOLATIONS) {
    it(`L${expected.line} fires ${expected.postconditionId} — ${expected.label}`, () => {
      const viols = result.violationsByLine.get(expected.line) ?? [];
      const matched = viols.some(v => v.postconditionId === expected.postconditionId);
      if (!matched) {
        const actualIds = viols.length > 0
          ? viols.map(v => `${v.postconditionId}(${v.severity})`).join(', ')
          : 'none';
        expect(matched, [
          `Expected ${expected.postconditionId} at line ${expected.line} but got: [${actualIds}]`,
          `  Label: ${expected.label}`,
          `  Hint: check scanner detection or contract postcondition ID.`,
        ].join('\n')).toBe(true);
      }
    });
  }

  // SHOULD_NOT_FIRE: @expect-clean call sites must not produce error-level violations
  for (const clean of EXPECTED_CLEAN_LINES) {
    it(`L${clean.line} is clean — ${clean.label}`, () => {
      const viols = result.violationsByLine.get(clean.line) ?? [];
      const errorViols = viols.filter(v => v.severity === 'error');
      if (errorViols.length > 0) {
        const ids = errorViols.map(v => `${v.postconditionId}(${v.severity})`).join(', ');
        expect(errorViols.length, [
          `Line ${clean.line}: expected no error-level violation but got: [${ids}]`,
          `  Label: ${clean.label}`,
        ].join('\n')).toBe(0);
      }
    });
  }
});
