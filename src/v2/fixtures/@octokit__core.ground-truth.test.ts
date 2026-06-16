/**
 * @octokit/core Ground-Truth Tests
 *
 * Each SHOULD_FIRE / SHOULD_NOT_FIRE annotation in
 * nark-corpus-pro/packages/@octokit/core/fixtures/ground-truth.ts becomes one test case.
 *
 * Postcondition IDs from nark-corpus-pro/packages/@octokit/core/contract.yaml:
 *   must-handle-request-error   (octokit.request() without try-catch)
 *   must-handle-graphql-error   (octokit.graphql() without try-catch)
 *   must-handle-auth-error      (octokit.auth() without try-catch when authStrategy set)
 *
 * Key behaviors under test:
 *   - await octokit.request(...) without try-catch → SHOULD_FIRE
 *   - await octokit.graphql(...) without try-catch → SHOULD_FIRE
 *   - await octokit.auth(...) without try-catch → SHOULD_FIRE
 *   - await octokit.request(...) inside try-catch → SHOULD_NOT_FIRE
 *   - await octokit.request(...) with .catch() → SHOULD_NOT_FIRE
 *   - await octokit.graphql(...) inside try-catch → SHOULD_NOT_FIRE
 *   - await octokit.auth(...) inside try-catch → SHOULD_NOT_FIRE
 *
 * Scoping note: detection is scoped to `import_source: "@octokit/core"` in the contract;
 * this profile must NOT fire when `Octokit` is imported from `@octokit/rest` or from
 * `octokit` (those have separate profiles in nark-corpus / nark-corpus-pro).
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
  'packages/@octokit/core/fixtures/ground-truth.ts'
);

const ANNOTATIONS: Annotation[] = parseAnnotations(GROUND_TRUTH_PATH);

describe('@octokit/core: ground-truth fixture', () => {
  let result: GroundTruthResult;

  beforeAll(async () => {
    result = await runGroundTruth(GROUND_TRUTH_PATH, CORPUS_PRO_PATH, {
      includeDrafts: true,
      packageName: '@octokit/core',
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
