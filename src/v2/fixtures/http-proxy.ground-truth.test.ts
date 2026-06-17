/**
 * http-proxy Ground-Truth Tests
 *
 * Each SHOULD_FIRE / SHOULD_NOT_FIRE annotation in
 * nark-corpus-pro/packages/http-proxy/fixtures/ground-truth.ts
 * becomes one test case.
 *
 * Postcondition IDs from contract.yaml:
 *   missing-error-listener (createProxyServer, createProxy)
 *
 * Key behaviors under test:
 *   - createProxyServer() without .on('error', handler) → SHOULD_FIRE (missing-error-listener)
 *   - createProxy() without .on('error', handler)       → SHOULD_FIRE (missing-error-listener)
 *   - createServer() — NOT auto-detected (factory_methods deliberately omits it
 *                       to avoid collision with node http.createServer) → SHOULD_NOT_FIRE
 *   - createProxyServer() WITH .on('error', ...) → SHOULD_NOT_FIRE
 *   - Chained createProxyServer().on('error', ...) → SHOULD_NOT_FIRE
 *   - Class property with error listener in constructor → SHOULD_NOT_FIRE
 *
 * Detection path: factory_methods (createProxyServer, createProxy) +
 *   required_event_listeners (error) →
 *   EventListenerAbsencePlugin tracks instances →
 *   ContractMatcher.handleMissingEventListener emits violation if .on('error') absent.
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

// Pro-tier profile lives in nark-corpus-pro, not nark-corpus.
const CORPUS_PRO_PATH = path.resolve(__dirname, '../../../../nark-corpus-pro');

const GROUND_TRUTH_PATH = path.resolve(
  __dirname,
  '../../../../nark-corpus-pro/packages/http-proxy/fixtures/ground-truth.ts'
);

const ANNOTATIONS: Annotation[] = parseAnnotations(GROUND_TRUTH_PATH);

describe('http-proxy: ground-truth fixture', () => {
  let result: GroundTruthResult;

  beforeAll(async () => {
    result = await runGroundTruth(GROUND_TRUTH_PATH, CORPUS_PRO_PATH, {
      includeDrafts: true,
      packageName: 'http-proxy',
    });
  });

  it('analyzer runs without errors', () => {
    expect(result).toBeDefined();
    expect(Array.isArray(result.violations)).toBe(true);
  });

  it('fixture has SHOULD_FIRE and SHOULD_NOT_FIRE annotations', () => {
    expect(ANNOTATIONS.filter((a) => a.kind === 'SHOULD_FIRE').length).toBeGreaterThan(0);
    expect(ANNOTATIONS.filter((a) => a.kind === 'SHOULD_NOT_FIRE').length).toBeGreaterThan(0);
  });

  for (const ann of ANNOTATIONS.filter((a) => a.kind === 'SHOULD_FIRE')) {
    it(`line ${ann.line} should fire ${ann.postconditionId} — ${ann.reason.substring(0, 60)}`, () => {
      const check = assertFires(result.violationsByLine, ann);
      expect(check.passed, check.message).toBe(true);
    });
  }

  for (const ann of ANNOTATIONS.filter((a) => a.kind === 'SHOULD_NOT_FIRE')) {
    it(`line ${ann.line} should not fire — ${ann.reason.substring(0, 60)}`, () => {
      const check = assertNotFires(result.violationsByLine, ann);
      expect(check.passed, check.message).toBe(true);
    });
  }
});
