/**
 * firebase-admin Ground-Truth Tests
 *
 * Each SHOULD_FIRE / SHOULD_NOT_FIRE annotation in
 * corpus/packages/firebase-admin/fixtures/ground-truth.ts becomes one test case.
 *
 * Postcondition IDs from corpus/packages/firebase-admin/contract.yaml:
 *   Auth:      token-expired (verifyIdToken), email-already-exists (createUser),
 *              user-not-found (getUser, updateUser)
 *   Firestore: permission-denied (get, add, delete), not-found (update), aborted (set)
 *   Messaging: invalid-recipient (send), partial-failure (sendMulticast)
 *   RTDB:      permission-denied (once, set, update, remove)
 *
 * Key behaviors under test:
 *   - admin.auth().verifyIdToken() without try-catch → SHOULD_FIRE: token-expired
 *   - auth.verifyIdToken() (stored instance) without try-catch → SHOULD_FIRE: token-expired
 *   - admin.auth().createUser() without try-catch → SHOULD_FIRE: email-already-exists
 *   - admin.auth().getUser() without try-catch → SHOULD_FIRE: user-not-found
 *   - admin.auth().updateUser() without try-catch → SHOULD_FIRE: user-not-found
 *   - db.collection().doc().get() without try-catch → SHOULD_FIRE: permission-denied
 *   - getFirestore().collection().doc().get() without try-catch → SHOULD_FIRE: permission-denied
 *   - db.collection().add() without try-catch → SHOULD_FIRE: permission-denied
 *   - db.collection().doc().update() without try-catch → SHOULD_FIRE: not-found
 *   - admin.messaging().send() without try-catch → SHOULD_FIRE: invalid-recipient
 *   - admin.database().ref().once() without try-catch → SHOULD_FIRE: permission-denied
 *   - getDatabase().ref().once() without try-catch → SHOULD_FIRE: permission-denied
 *   - All above with try-catch → SHOULD_NOT_FIRE
 *
 * Detection patterns:
 *   - Namespace API: admin.auth().method(), admin.firestore(), admin.messaging(), admin.database()
 *   - Stored instance: const auth = admin.auth(); auth.method()
 *   - Modular subpath: getFirestore(), getDatabase() (normalized to firebase-admin)
 *   - Note: getAuth().method() modular pattern not yet detected (analyzer limitation)
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
  '../../../../corpus/packages/firebase-admin/fixtures/ground-truth.ts'
);

const ANNOTATIONS: Annotation[] = parseAnnotations(GROUND_TRUTH_PATH);

describe('firebase-admin: ground-truth fixture', () => {
  let result: GroundTruthResult;

  beforeAll(async () => {
    result = await runGroundTruth(GROUND_TRUTH_PATH, CORPUS_PATH, { includeDrafts: true });
  });

  it('analyzer runs without errors', () => {
    expect(result).toBeDefined();
    expect(Array.isArray(result.violations)).toBe(true);
  });

  it('fixture has SHOULD_FIRE and SHOULD_NOT_FIRE annotations', () => {
    expect(ANNOTATIONS.filter(a => a.kind === 'SHOULD_FIRE').length).toBeGreaterThan(0);
    expect(ANNOTATIONS.filter(a => a.kind === 'SHOULD_NOT_FIRE').length).toBeGreaterThan(0);
  });

  // One test per SHOULD_FIRE annotation
  for (const ann of ANNOTATIONS.filter(a => a.kind === 'SHOULD_FIRE')) {
    it(`line ${ann.line} should fire ${ann.postconditionId} — ${ann.reason.substring(0, 60)}`, () => {
      const check = assertFires(result.violationsByLine, ann);
      expect(check.passed, check.message).toBe(true);
    });
  }

  // One test per SHOULD_NOT_FIRE annotation
  for (const ann of ANNOTATIONS.filter(a => a.kind === 'SHOULD_NOT_FIRE')) {
    it(`line ${ann.line} should not fire — ${ann.reason.substring(0, 60)}`, () => {
      const check = assertNotFires(result.violationsByLine, ann);
      expect(check.passed, check.message).toBe(true);
    });
  }
});
