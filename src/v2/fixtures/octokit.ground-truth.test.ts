/**
 * `octokit` Ground-Truth Tests
 *
 * Each SHOULD_FIRE / SHOULD_NOT_FIRE annotation in
 * nark-corpus-pro/packages/octokit/fixtures/ground-truth.ts becomes one test case.
 *
 * Postcondition IDs from nark-corpus-pro/packages/octokit/contract.yaml:
 *   octokit-request-no-try-catch
 *   octokit-graphql-no-try-catch
 *   octokit-paginate-no-try-catch
 *   octokit-rest-repos-get-no-try-catch
 *   octokit-rest-repos-create-no-try-catch
 *   octokit-rest-pulls-create-no-try-catch
 *   octokit-app-get-installation-octokit-no-try-catch
 *   octokit-app-each-installation-no-try-catch
 *   octokit-app-each-repository-no-try-catch
 *
 * Key behaviors under test:
 *   - await octokit.{request,graphql,paginate}(...) without try/catch → SHOULD_FIRE
 *   - await octokit.rest.{repos,pulls}.* without try/catch → SHOULD_FIRE
 *   - await app.{getInstallationOctokit,eachInstallation,eachRepository}(...) without try/catch → SHOULD_FIRE
 *   - All of the above inside try/catch OR with .catch() chain → SHOULD_NOT_FIRE
 *   - Detection is import-source scoped: only matches imports from "octokit",
 *     not "@octokit/rest" or "@octokit/app".
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
  'packages/octokit/fixtures/ground-truth.ts'
);

const ANNOTATIONS: Annotation[] = parseAnnotations(GROUND_TRUTH_PATH);

describe('octokit: ground-truth fixture', () => {
  let result: GroundTruthResult;

  beforeAll(async () => {
    result = await runGroundTruth(GROUND_TRUTH_PATH, CORPUS_PRO_PATH, {
      includeDrafts: true,
      packageName: 'octokit',
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
