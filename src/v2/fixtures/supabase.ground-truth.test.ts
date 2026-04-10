/**
 * @supabase/supabase-js Ground-Truth Tests
 *
 * Tests the builder-pattern result API: supabase.from('table').select/insert/update/delete/rpc()
 *
 * Root cause this file validates: V2 was attributing the supabase variable to 'redis'
 * because factoryToPackage['createClient'] was set by the redis contract, and the lookup
 * happened before checking importMap. Fixed by checking importMap first in
 * InstanceTrackerPlugin.resolveFactoryCall().
 *
 * Postcondition IDs from corpus/packages/@supabase/supabase-js/contract.yaml:
 *   select: rls-policy-violation, column-access-denied, connection-error
 *   insert: rls-policy-violation, unique-constraint-violation, foreign-key-violation, connection-error
 *   update: rls-policy-violation, record-not-found, unique-constraint-violation
 *   delete: rls-policy-violation, foreign-key-violation
 *   rpc:    function-not-found, permission-denied, rpc-error
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
  '../../../../corpus/packages/@supabase/supabase-js/fixtures/ground-truth.ts'
);

const ANNOTATIONS: Annotation[] = parseAnnotations(GROUND_TRUTH_PATH);

describe('@supabase/supabase-js: ground-truth fixture', () => {
  let result: GroundTruthResult;

  beforeAll(async () => {
    result = await runGroundTruth(GROUND_TRUTH_PATH, CORPUS_PATH);
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
