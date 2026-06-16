/**
 * @xenova/transformers Ground-Truth Tests
 *
 * Each SHOULD_FIRE / SHOULD_NOT_FIRE annotation in
 * nark-corpus-pro/packages/@xenova/transformers/fixtures/ground-truth.ts becomes one test case.
 *
 * Postcondition IDs from nark-corpus-pro/packages/@xenova/transformers/contract.yaml:
 *   pipeline-network-or-config-error
 *   from-pretrained-network-or-config-error
 *
 * Key behaviors under test:
 *   - await pipeline(task, model)                          no try-catch       → SHOULD_FIRE
 *   - await pipeline(...) inside try-catch                                    → SHOULD_NOT_FIRE
 *   - pipeline(...).then(...).catch(err => ...)            .catch attached    → SHOULD_NOT_FIRE
 *   - await PreTrainedTokenizer.from_pretrained(model)     no try-catch       → SHOULD_FIRE
 *   - await AutoModel.from_pretrained(model)               no try-catch       → SHOULD_FIRE
 *   - await AutoTokenizer.from_pretrained(model)           no try-catch       → SHOULD_FIRE
 *   - await PreTrainedTokenizer.from_pretrained(...) in try-catch             → SHOULD_NOT_FIRE
 *   - AutoModel.from_pretrained(...).catch(err => ...)     .catch attached    → SHOULD_NOT_FIRE
 *   - this.extractor = await pipeline(...) inside init()   no try-catch       → SHOULD_FIRE
 *   - this.extractor = await pipeline(...) inside try-catch                   → SHOULD_NOT_FIRE
 *
 * Design: spec-driven, NOT based on V1 behavior.
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

// nark-corpus-pro is a sibling of nark-corpus: ../../../../nark-corpus-pro
const CORPUS_PRO_PATH = path.resolve(__dirname, '../../../../nark-corpus-pro');

const GROUND_TRUTH_PATH = path.resolve(
  CORPUS_PRO_PATH,
  'packages/@xenova/transformers/fixtures/ground-truth.ts'
);

const ANNOTATIONS: Annotation[] = parseAnnotations(GROUND_TRUTH_PATH);

describe('@xenova/transformers: ground-truth fixture', () => {
  let result: GroundTruthResult;

  beforeAll(async () => {
    result = await runGroundTruth(GROUND_TRUTH_PATH, CORPUS_PRO_PATH, {
      includeDrafts: true,
      packageName: '@xenova/transformers',
    });
  });

  it('analyzer runs without errors', () => {
    expect(result).toBeDefined();
    expect(Array.isArray(result.violations)).toBe(true);
  });

  it('fixture has SHOULD_FIRE and SHOULD_NOT_FIRE annotations', () => {
    expect(ANNOTATIONS.filter(a => a.kind === 'SHOULD_FIRE').length).toBeGreaterThan(0);
    expect(ANNOTATIONS.filter(a => a.kind === 'SHOULD_NOT_FIRE').length).toBeGreaterThan(0);
  });

  for (const ann of ANNOTATIONS.filter(a => a.kind === 'SHOULD_FIRE')) {
    it(`line ${ann.line} should fire ${ann.postconditionId} — ${ann.reason.substring(0, 60)}`, () => {
      const check = assertFires(result.violationsByLine, ann);
      expect(check.passed, check.message).toBe(true);
    });
  }

  for (const ann of ANNOTATIONS.filter(a => a.kind === 'SHOULD_NOT_FIRE')) {
    it(`line ${ann.line} should not fire — ${ann.reason.substring(0, 60)}`, () => {
      const check = assertNotFires(result.violationsByLine, ann);
      expect(check.passed, check.message).toBe(true);
    });
  }
});
