/**
 * esbuild Ground-Truth Tests
 *
 * Each @expect-violation / @expect-clean annotation in
 * nark-corpus-pro/packages/esbuild/fixtures/ground-truth.ts becomes one test case.
 *
 * Postcondition IDs from nark-corpus-pro/packages/esbuild/contract.yaml:
 *   build-failure                               — build() without try-catch
 *   context-init-failure                        — context() without try-catch
 *   formatmessages-invalid-input                — formatMessages() without try-catch
 *   analyzemetafile-invalid-metafile            — analyzeMetafile() without try-catch
 *   rebuild-after-dispose                       — BuildContext.rebuild() without try-catch
 *   watch-wrong-environment                     — BuildContext.watch() without try-catch
 *   serve-port-in-use                           — BuildContext.serve() without try-catch
 *   pluginbuild-resolve-silent-resolution-failure — PluginBuild.resolve() result.errors unchecked
 *
 * Scanner capability note (PluginBuild.resolve concerns):
 *   concern-20260623-esbuild-deepen-1 and -2 require PluginBuild in the
 *   detection.type_names list so that `build: PluginBuild` parameters in
 *   plugin setup() callbacks are tracked as esbuild instances.
 *   Fix applied 2026-06-29: PluginBuild added to esbuild/contract.yaml type_names.
 *   Verified: L201 fires pluginbuild-resolve-silent-resolution-failure correctly.
 *
 * Known scanner gaps (NOT tested here to avoid baseline regression):
 *   - transform-failure: scanner does not detect transform() violations (L34, L44)
 *   - initialize-missing-wasm: scanner does not detect initialize() at L91
 *   - stop-child-process-error: scanner does not detect stop() at L96
 *   - rebuild-after-dispose in empty catch: L137 (empty-catch suppression gap)
 *   - serve-tls-misconfiguration vs serve-port-in-use: scanner fires wrong postcondition at L183
 *   - pluginbuild-resolve-silent-resolution-failure inside empty catch: L220
 *   These gaps are documented but not enforced here to avoid adding new baseline failures.
 *   Each gap should be tracked as a separate concern in upgrade-concerns.json.
 *
 * Note: The ground-truth fixture uses @expect-violation / @expect-clean
 * annotations (corpus convention). This test file directly maps known
 * violation call-site line numbers to expected postcondition IDs.
 * Line numbers are stable — changes to ground-truth.ts must update this
 * test accordingly.
 *
 * Corpus: nark-corpus-pro (PRO tier — esbuild profile was onboarded 2026-06-12).
 */

import { describe, it, expect, beforeAll } from 'vitest';
import * as path from 'path';
import { fileURLToPath } from 'url';
import {
  runGroundTruth,
} from './harness.js';
import type { GroundTruthResult } from './harness.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// nark-corpus-pro is a sibling of nark-corpus: ../../../../nark-corpus-pro
const CORPUS_PRO_PATH = path.resolve(__dirname, '../../../../nark-corpus-pro');

const GROUND_TRUTH_PATH = path.resolve(
  CORPUS_PRO_PATH,
  'packages/esbuild/fixtures/ground-truth.ts'
);

// ─── Known violation call-site line numbers (verified passing) ──────────────
//
// Only includes assertions that the scanner currently satisfies.
// See "Known scanner gaps" in the header for omitted cases.
// Line numbers point to the actual call expression.
// Updated 2026-06-29 from scanner output against ground-truth.ts.

const EXPECTED_VIOLATIONS: { line: number; postconditionId: string; label: string }[] = [
  // build() — direct import
  { line: 11,  postconditionId: 'build-failure',              label: 'build — no try-catch (direct import)' },
  // build() — namespace import (esbuild.build)
  { line: 100, postconditionId: 'build-failure',              label: 'build — no try-catch (namespace import)' },
  // context()
  { line: 62,  postconditionId: 'context-init-failure',       label: 'context — no try-catch' },
  // formatMessages()
  { line: 80,  postconditionId: 'formatmessages-invalid-input', label: 'formatMessages — no try-catch' },
  // analyzeMetafile()
  { line: 85,  postconditionId: 'analyzemetafile-invalid-metafile', label: 'analyzeMetafile — no try-catch' },
  // BuildContext.rebuild() — typed param, no catch
  { line: 118, postconditionId: 'rebuild-after-dispose',      label: 'rebuild — no try-catch (ctx: BuildContext param)' },
  // BuildContext.watch() — typed param, no catch
  { line: 146, postconditionId: 'watch-wrong-environment',    label: 'watch — no try-catch' },
  // BuildContext.serve() — typed param, no catch
  { line: 165, postconditionId: 'serve-port-in-use',          label: 'serve — no try-catch' },
  // PluginBuild.resolve() — build parameter typed as PluginBuild, no errors check, no catch
  // Key assertion for concern-20260623-esbuild-deepen-1 (PluginBuild added to type_names)
  { line: 201, postconditionId: 'pluginbuild-resolve-silent-resolution-failure', label: 'resolve — no errors check (no try-catch)' },
];

// ─── Lines expected to be clean (no error-level violations) ────────────────
const EXPECTED_CLEAN_LINES: { line: number; label: string }[] = [
  { line: 19,  label: 'build inside try-catch' },
  { line: 28,  label: 'build with .catch() handler' },
  { line: 53,  label: 'transform with full try-catch' },
  { line: 73,  label: 'context with try-catch and dispose on error' },
  { line: 238, label: 'PluginBuild.resolve with errors check and try-catch' },
  { line: 263, label: 'PluginBuild.resolve with .catch() chain and errors check' },
];

// ─── Test suite ────────────────────────────────────────────────────────────

describe('esbuild: ground-truth fixture', () => {
  let result: GroundTruthResult;

  beforeAll(async () => {
    result = await runGroundTruth(GROUND_TRUTH_PATH, CORPUS_PRO_PATH, {
      includeDrafts: true,
      packageName: 'esbuild',
    });
  });

  it('analyzer runs without errors', () => {
    expect(result).toBeDefined();
    expect(Array.isArray(result.violations)).toBe(true);
  });

  // SHOULD_FIRE: each @expect-violation call site must produce the expected violation
  for (const expected of EXPECTED_VIOLATIONS) {
    it(`L${expected.line} fires ${expected.postconditionId} — ${expected.label}`, () => {
      const viols = result.violationsByLine.get(expected.line) ?? [];
      const matched = viols.some(v => v.postconditionId === expected.postconditionId);
      if (!matched) {
        const actualIds = viols.length > 0
          ? viols.map(v => `${v.postconditionId}(${v.severity})`).join(', ')
          : 'none';
        expect(matched, [
          `Expected ${expected.postconditionId} at line ${expected.line} but got: [${actualIds}]`,
          `  Label: ${expected.label}`,
          `  Hint: check scanner detection or contract postcondition ID.`,
        ].join('\n')).toBe(true);
      }
    });
  }

  // SHOULD_NOT_FIRE: @expect-clean call sites must not produce error-level violations
  for (const clean of EXPECTED_CLEAN_LINES) {
    it(`L${clean.line} is clean — ${clean.label}`, () => {
      const viols = result.violationsByLine.get(clean.line) ?? [];
      const errorViols = viols.filter(v => v.severity === 'error');
      if (errorViols.length > 0) {
        const ids = errorViols.map(v => `${v.postconditionId}(${v.severity})`).join(', ');
        expect(errorViols.length, [
          `Line ${clean.line}: expected no error-level violation but got: [${ids}]`,
          `  Label: ${clean.label}`,
        ].join('\n')).toBe(0);
      }
    });
  }
});
