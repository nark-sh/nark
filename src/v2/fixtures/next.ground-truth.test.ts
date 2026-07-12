/**
 * next Ground-Truth Tests
 *
 * Each SHOULD_FIRE / SHOULD_NOT_FIRE annotation in
 * nark-corpus/packages/next/fixtures/ground-truth.ts becomes one test case.
 *
 * Postcondition IDs from nark-corpus/packages/next/contract.yaml (deepen-stream-3 pass 56 additions):
 *   forbidden-inside-try-catch: forbidden() inside try-catch silently swallows the 403 throw
 *   unauthorized-inside-try-catch: unauthorized() inside try-catch swallows the 401 throw
 *   connection-missing-await: connection() without await defeats the dynamic-boundary signal
 *   connection-inside-after: connection() inside after() throws E827 at runtime
 *   draft-mode-missing-await: draftMode() without await returns Promise, all checks return undefined
 *   after-error-swallowed: after() callback error not handled — logged to stderr, never surfaces
 *   update-tag-after-redirect: updateTag() called after redirect() is dead code (redirect throws first)
 *   update-tag-outside-server-action: updateTag() called outside a Server Action throws
 *   revalidate-after-redirect: revalidatePath() called after redirect() is dead code (concern-20260712-lead-08)
 *   revalidate-tag-after-redirect: revalidateTag() called after redirect() is dead code (concern-20260712-lead-08)
 *
 * Key behaviors under test (deepen-stream-3 additions):
 *   - forbidden() inside try-catch                → SHOULD_FIRE: forbidden-inside-try-catch
 *   - forbidden() outside try-catch               → SHOULD_NOT_FIRE
 *   - unauthorized() inside try-catch             → SHOULD_FIRE: unauthorized-inside-try-catch
 *   - unauthorized() outside try-catch            → SHOULD_NOT_FIRE
 *   - connection() without await                  → SHOULD_FIRE: connection-missing-await
 *   - connection() with await                     → SHOULD_NOT_FIRE
 *   - connection() inside after() callback        → SHOULD_FIRE: connection-inside-after
 *   - connection() before after() (correct)       → SHOULD_NOT_FIRE
 *   - draftMode() without await                   → SHOULD_FIRE: draft-mode-missing-await
 *   - draftMode() with await                      → SHOULD_NOT_FIRE
 *   - after() callback without try-catch          → SHOULD_FIRE: after-error-swallowed
 *   - after() callback with try-catch             → SHOULD_NOT_FIRE
 *   - updateTag() after redirect()                → SHOULD_FIRE: update-tag-after-redirect
 *   - updateTag() before redirect()               → SHOULD_NOT_FIRE
 *   - updateTag() from Route Handler              → SHOULD_FIRE: update-tag-outside-server-action
 *   - revalidatePath() with no redirect in scope  → SHOULD_NOT_FIRE (FP fix: concern-20260712-lead-08)
 *   - revalidatePath() before redirect()          → SHOULD_NOT_FIRE
 *   - revalidatePath() after redirect()           → SHOULD_FIRE: revalidate-after-redirect
 *   - revalidateTag() with no redirect in scope   → SHOULD_NOT_FIRE (FP fix: concern-20260712-lead-08)
 *   - revalidateTag() after redirect()            → SHOULD_FIRE: revalidate-tag-after-redirect
 *
 * Functions from 'next/navigation', 'next/server', 'next/headers', 'next/cache'.
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
  "../../../../nark-corpus/packages/next/fixtures/ground-truth.ts",
);

const ANNOTATIONS: Annotation[] = parseAnnotations(GROUND_TRUTH_PATH);

describe("next: ground-truth fixture", () => {
  let result: GroundTruthResult;

  beforeAll(async () => {
    result = await runGroundTruth(GROUND_TRUTH_PATH, CORPUS_PATH);
  });

  it("analyzer runs without errors", () => {
    expect(result).toBeDefined();
    expect(Array.isArray(result.violations)).toBe(true);
  });

  it("fixture has SHOULD_FIRE annotations", () => {
    expect(
      ANNOTATIONS.filter((a) => a.kind === "SHOULD_FIRE").length,
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
