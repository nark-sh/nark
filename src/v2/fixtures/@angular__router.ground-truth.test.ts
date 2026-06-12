/**
 * @angular/router Ground-Truth Tests
 *
 * Each SHOULD_FIRE / SHOULD_NOT_FIRE annotation in
 * nark-corpus-pro/packages/@angular/router/fixtures/ground-truth.ts becomes
 * one test case.
 *
 * Contracted functions (2 total):
 *   - navigate(commands, extras?)      — Promise rejects on NavigationError
 *   - navigateByUrl(url, extras?)      — Promise rejects on NavigationError
 *
 * Key behaviors under test:
 *   - this.router.navigate(...) outside try/catch       → SHOULD_FIRE (navigate-not-wrapped)
 *   - this.router.navigate(...) inside try/catch        → SHOULD_NOT_FIRE
 *   - this.router.navigate(...).catch(...)              → SHOULD_NOT_FIRE
 *   - this.router.navigateByUrl(...) outside try/catch  → SHOULD_FIRE (navigate-by-url-not-wrapped)
 *   - this.router.navigateByUrl(...) inside try/catch   → SHOULD_NOT_FIRE
 *   - this.router.navigateByUrl(...).catch(...)         → SHOULD_NOT_FIRE
 *
 * Detection strategy: PropertyChainDetectorPlugin via InstanceTrackerPlugin
 * type-annotation walk. The Router class is registered as type_names: [Router]
 * in the contract, so `constructor(private router: Router)` causes `router` to
 * be tracked as an @angular/router instance; `this.router.navigate(...)` is then
 * resolved to the navigate() postcondition via depth-2 property chain detection.
 *
 * Corpus: nark-corpus-pro (PRO tier — Angular routing is a paid-tier profile).
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

// Points to nark-corpus-pro, not nark-corpus
const PRO_CORPUS_PATH = path.resolve(__dirname, '../../../../nark-corpus-pro');

const GROUND_TRUTH_PATH = path.resolve(
  __dirname,
  '../../../../nark-corpus-pro/packages/@angular/router/fixtures/ground-truth.ts'
);

const ANNOTATIONS: Annotation[] = parseAnnotations(GROUND_TRUTH_PATH);

describe('@angular/router: ground-truth fixture', () => {
  let result: GroundTruthResult;

  beforeAll(async () => {
    result = await runGroundTruth(GROUND_TRUTH_PATH, PRO_CORPUS_PATH, { includeDrafts: true });
  });

  it('analyzer runs without errors', () => {
    expect(result).toBeDefined();
    expect(Array.isArray(result.violations)).toBe(true);
  });

  it('fixture has SHOULD_FIRE and SHOULD_NOT_FIRE annotations', () => {
    expect(ANNOTATIONS.filter((a: Annotation) => a.kind === 'SHOULD_FIRE').length).toBeGreaterThan(0);
    expect(ANNOTATIONS.filter((a: Annotation) => a.kind === 'SHOULD_NOT_FIRE').length).toBeGreaterThan(0);
  });

  for (const ann of ANNOTATIONS.filter((a: Annotation) => a.kind === 'SHOULD_FIRE')) {
    it(`line ${ann.line} should fire ${ann.postconditionId} — ${ann.reason.substring(0, 60)}`, () => {
      const check = assertFires(result.violationsByLine, ann);
      expect(check.passed, check.message).toBe(true);
    });
  }

  for (const ann of ANNOTATIONS.filter((a: Annotation) => a.kind === 'SHOULD_NOT_FIRE')) {
    it(`line ${ann.line} should not fire — ${ann.reason.substring(0, 60)}`, () => {
      const check = assertNotFires(result.violationsByLine, ann);
      expect(check.passed, check.message).toBe(true);
    });
  }
});
