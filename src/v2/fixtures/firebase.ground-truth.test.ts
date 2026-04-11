/**
 * firebase Ground-Truth Tests
 *
 * Each SHOULD_FIRE / SHOULD_NOT_FIRE annotation in
 * corpus/packages/firebase/fixtures/ground-truth.ts becomes one test case.
 *
 * Postcondition IDs from corpus/packages/firebase/contract.yaml:
 *   auth-error          (signInWithEmailAndPassword, createUserWithEmailAndPassword, signInWithPopup)
 *   firestore-error     (getDocs, addDoc, setDoc, updateDoc, deleteDoc)
 *
 * Key behaviors under test:
 *   - signInWithEmailAndPassword() without try-catch → SHOULD_FIRE: auth-error
 *   - createUserWithEmailAndPassword() without try-catch → SHOULD_FIRE: auth-error
 *   - signInWithPopup() without try-catch → SHOULD_FIRE: auth-error
 *   - getDocs() without try-catch → SHOULD_FIRE: firestore-error
 *   - addDoc() without try-catch → SHOULD_FIRE: firestore-error
 *   - setDoc() without try-catch → SHOULD_FIRE: firestore-error
 *   - updateDoc() without try-catch → SHOULD_FIRE: firestore-error
 *   - deleteDoc() without try-catch → SHOULD_FIRE: firestore-error
 *   - All with try-catch → SHOULD_NOT_FIRE
 *   - signInWithEmailAndPassword with .catch() → SHOULD_NOT_FIRE
 *
 * Detection: direct function calls — imported from firebase/auth and firebase/firestore
 * subpaths, normalized to 'firebase' package by the import tracker.
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
  '../../../../nark-corpus/packages/firebase/fixtures/ground-truth.ts'
);

const ANNOTATIONS: Annotation[] = parseAnnotations(GROUND_TRUTH_PATH);

describe('firebase: ground-truth fixture', () => {
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
