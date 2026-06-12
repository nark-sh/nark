/**
 * @umami/node Ground-Truth Tests
 *
 * Validates that umami.track() / umami.identify() / umami.send() callsites without
 * try-catch (and without .catch()) fire the corresponding contract postconditions,
 * and that protected forms (try-catch around await, .catch() on fire-and-forget,
 * .then().catch() chain) do NOT fire.
 *
 * Contract in nark-corpus-pro. Postconditions:
 *   track-no-try-catch     — singleton + instance .track()
 *   identify-no-try-catch  — singleton + instance .identify()
 *   send-no-try-catch      — singleton + instance .send()
 */

import { describe, it, expect, beforeAll } from "vitest";
import * as path from "path";
import { fileURLToPath } from "url";
import {
  runGroundTruth,
  parseAnnotations,
  assertFires,
  assertNotFires,
} from "./harness.js";
import type { GroundTruthResult, Annotation } from "./harness.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PRO_CORPUS_PATH = path.resolve(__dirname, "../../../../nark-corpus-pro");
const GROUND_TRUTH_PATH = path.resolve(
  PRO_CORPUS_PATH,
  "packages/@umami/node/fixtures/ground-truth.ts",
);

const ANNOTATIONS: Annotation[] = parseAnnotations(GROUND_TRUTH_PATH);

describe("@umami/node: ground-truth fixture", () => {
  let result: GroundTruthResult;

  beforeAll(async () => {
    result = await runGroundTruth(GROUND_TRUTH_PATH, PRO_CORPUS_PATH, {
      includeDrafts: true,
      packageName: "@umami/node",
    });
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

  for (const ann of ANNOTATIONS.filter((a) => a.kind === "SHOULD_FIRE")) {
    it(`line ${ann.line} should fire ${ann.postconditionId} — ${ann.reason.substring(0, 60)}`, () => {
      const check = assertFires(result.violationsByLine, ann);
      expect(check.passed, check.message).toBe(true);
    });
  }

  for (const ann of ANNOTATIONS.filter((a) => a.kind === "SHOULD_NOT_FIRE")) {
    it(`line ${ann.line} should not fire — ${ann.reason.substring(0, 60)}`, () => {
      const check = assertNotFires(result.violationsByLine, ann);
      expect(check.passed, check.message).toBe(true);
    });
  }
});
