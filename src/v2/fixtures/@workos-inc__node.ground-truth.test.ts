/**
 * @workos-inc/node Ground-Truth Tests
 *
 * Each SHOULD_FIRE / SHOULD_NOT_FIRE annotation in
 * nark-corpus-pro/packages/@workos-inc/node/fixtures/ground-truth.ts becomes one test case.
 *
 * Postcondition IDs from nark-corpus-pro/packages/@workos-inc/node/contract.yaml:
 *   authenticate-with-code-no-error-handling
 *   authenticate-with-password-no-error-handling
 *   authenticate-with-refresh-token-no-error-handling
 *   authenticate-with-magic-auth-no-error-handling
 *   authenticate-with-email-verification-no-error-handling
 *   create-user-no-error-handling
 *   delete-user-no-error-handling
 *   send-invitation-no-error-handling
 *   revoke-session-no-error-handling
 *   get-profile-and-token-no-error-handling
 *   get-profile-no-error-handling
 *   get-organization-no-error-handling
 *   create-organization-no-error-handling
 *   directory-list-users-no-error-handling
 *   passwordless-create-session-no-error-handling
 *   webhook-construct-event-no-error-handling
 *
 * Key behaviors under test:
 *   - await workos.<module>.<method>(...) without try-catch → SHOULD_FIRE
 *   - same call inside an enclosing try/catch              → SHOULD_NOT_FIRE
 *
 * Detection: namespaced instance methods on a `new WorkOS(...)` client.
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
  'packages/@workos-inc/node/fixtures/ground-truth.ts'
);

const ANNOTATIONS: Annotation[] = parseAnnotations(GROUND_TRUTH_PATH);

describe('@workos-inc/node: ground-truth fixture', () => {
  let result: GroundTruthResult;

  beforeAll(async () => {
    result = await runGroundTruth(GROUND_TRUTH_PATH, CORPUS_PRO_PATH, {
      includeDrafts: true,
      packageName: '@workos-inc/node',
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
