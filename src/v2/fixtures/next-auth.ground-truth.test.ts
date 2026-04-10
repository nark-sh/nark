/**
 * next-auth Ground-Truth Tests
 *
 * Each SHOULD_FIRE / SHOULD_NOT_FIRE annotation in
 * corpus/packages/next-auth/fixtures/ground-truth.ts becomes one test case.
 *
 * Postcondition IDs from corpus/packages/next-auth/contract.yaml:
 *   encode-no-try-catch: encode() called without try/catch — throws if secret missing
 *   decode-no-try-catch: decode() called without try/catch — throws on wrong secret/malformed token
 *   getserversession-null-not-checked: getServerSession() returns null without null guard
 *   gettoken-null-not-checked: getToken() returns null without null guard
 *   getsession-null-not-checked: getSession() returns null without null guard
 *
 * Key behaviors under test:
 *   - encode() without try-catch             → SHOULD_FIRE: encode-no-try-catch
 *   - encode() inside try-catch              → SHOULD_NOT_FIRE
 *   - decode() without try-catch             → SHOULD_FIRE: decode-no-try-catch
 *   - decode() inside try-catch              → SHOULD_NOT_FIRE
 *   - getServerSession() without null check  → SHOULD_FIRE: getserversession-null-not-checked
 *   - getServerSession() with null check     → SHOULD_NOT_FIRE
 *   - getToken() without null check          → SHOULD_FIRE: gettoken-null-not-checked
 *   - getToken() with null check             → SHOULD_NOT_FIRE
 *   - getSession() without null check        → SHOULD_FIRE: getsession-null-not-checked
 *   - getSession() with null check           → SHOULD_NOT_FIRE
 *
 * Functions imported from 'next-auth/jwt', 'next-auth/next', 'next-auth/react' — no class pattern.
 */

import { describe, it, expect, beforeAll } from "vitest";
import * as path from "path";
import { fileURLToPath } from "url";
import {
  runGroundTruth,
  parseAnnotations,
  assertFires,
  assertNotFires,
  CORPUS_PATH,
} from "./harness.js";
import type { GroundTruthResult, Annotation } from "./harness.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const GROUND_TRUTH_PATH = path.resolve(
  __dirname,
  "../../../../corpus/packages/next-auth/fixtures/ground-truth.ts",
);

const ANNOTATIONS: Annotation[] = parseAnnotations(GROUND_TRUTH_PATH);

describe("next-auth: ground-truth fixture", () => {
  let result: GroundTruthResult;

  beforeAll(async () => {
    result = await runGroundTruth(GROUND_TRUTH_PATH, CORPUS_PATH);
  });

  it("analyzer runs without errors", () => {
    expect(result).toBeDefined();
    expect(Array.isArray(result.violations)).toBe(true);
  });

  it("fixture has SHOULD_FIRE and SHOULD_NOT_FIRE annotations", () => {
    expect(
      ANNOTATIONS.filter((a) => a.kind === "SHOULD_FIRE").length,
    ).toBeGreaterThan(0);
    expect(
      ANNOTATIONS.filter((a) => a.kind === "SHOULD_NOT_FIRE").length,
    ).toBeGreaterThan(0);
  });

  // One test per SHOULD_FIRE annotation
  for (const ann of ANNOTATIONS.filter((a) => a.kind === "SHOULD_FIRE")) {
    it(`line ${ann.line} should fire ${ann.postconditionId} — ${ann.reason.substring(0, 60)}`, () => {
      const check = assertFires(result.violationsByLine, ann);
      expect(check.passed, check.message).toBe(true);
    });
  }

  // One test per SHOULD_NOT_FIRE annotation
  for (const ann of ANNOTATIONS.filter((a) => a.kind === "SHOULD_NOT_FIRE")) {
    it(`line ${ann.line} should not fire — ${ann.reason.substring(0, 60)}`, () => {
      const check = assertNotFires(result.violationsByLine, ann);
      expect(check.passed, check.message).toBe(true);
    });
  }
});
