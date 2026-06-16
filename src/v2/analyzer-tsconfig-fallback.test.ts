/**
 * Regression test for UniversalAnalyzer.initialize() synthetic-tsconfig
 * fallback path.
 *
 * Concern: concern-20260615-missing-deps-named-import-resolution
 *
 * When a tsconfig extends a package that isn't installed (e.g. a Vite/Vue
 * project's `extends: "@vue/tsconfig/tsconfig.dom.json"` with no node_modules,
 * scanned via NARK_ALLOW_MISSING_DEPS=1), the analyzer falls back to a
 * synthetic compiler-options config so it can still walk the project's
 * `.ts` files. The earlier implementation returned from `initialize()`
 * immediately after creating `this.program` on the fallback branch —
 * which skipped the ContractMatcher creation entirely. Result: every scan
 * that hit the fallback path produced 0 violations even when detections
 * fired correctly. This test pins the fix.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { UniversalAnalyzer } from './analyzer.js';
import type { PackageContract } from '../types.js';

function makeTempProject(tsconfigContents: string, sourceFiles: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nark-fallback-test-'));
  fs.writeFileSync(path.join(dir, 'tsconfig.json'), tsconfigContents);
  for (const [name, content] of Object.entries(sourceFiles)) {
    const filePath = path.join(dir, name);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content);
  }
  return dir;
}

function makeMinimalContract(): Map<string, PackageContract> {
  // Synthetic contract: enough structure for the matcher to be created.
  // We don't exercise the matcher here — just verify it gets created.
  const contract: PackageContract = {
    package: 'fake-pkg',
    semver: '*',
    contract_version: '1.0.0',
    coverage_status: 'covered',
    status: 'production',
    functions: [
      {
        name: 'doThing',
        postconditions: [
          {
            id: 'fake-postcondition',
            condition: 'await doThing()',
            throws: 'Error',
            severity: 'error',
          } as any,
        ],
      },
    ],
  } as any;
  return new Map([['fake-pkg', contract]]);
}

describe('UniversalAnalyzer synthetic-tsconfig fallback', () => {
  it('creates a contract matcher when tsconfig extends an unresolved package', { timeout: 30000 }, () => {
    // tsconfig extends a package that won't resolve (no node_modules in temp dir).
    // This is exactly the shape of the modern-tar reproduction case.
    const projectDir = makeTempProject(
      JSON.stringify({
        extends: '@nonexistent-org/tsconfig/dom.json',
        compilerOptions: { strict: true },
      }),
      {
        'src/index.ts': "import { doThing } from 'fake-pkg';\nasync function go() { await doThing(); }\ngo();\n",
      },
    );

    const analyzer = new UniversalAnalyzer(
      { tsConfigPath: path.join(projectDir, 'tsconfig.json') } as any,
      makeMinimalContract(),
    );
    analyzer.initialize();

    // Before the fix, this was `undefined` because initialize() returned early
    // on the fallback branch before reaching the ContractMatcher creation step.
    expect((analyzer as any).contractMatcher).toBeDefined();
    // Program must also be set so analyze() can run.
    expect((analyzer as any).program).toBeDefined();
  });

  it('still creates a contract matcher on the normal (non-fallback) path', { timeout: 30000 }, () => {
    // No `extends` → no fallback triggered → normal path runs.
    // Explicit `include` keeps the file scan tight (otherwise TS recurses
    // into the whole temp dir which is fine but slow under vitest's 5s).
    const projectDir = makeTempProject(
      JSON.stringify({
        compilerOptions: { strict: true, target: 'ES2020' },
        include: ['src/**/*.ts'],
      }),
      {
        'src/index.ts': "import { doThing } from 'fake-pkg';\nasync function go() { await doThing(); }\ngo();\n",
      },
    );

    const analyzer = new UniversalAnalyzer(
      { tsConfigPath: path.join(projectDir, 'tsconfig.json') } as any,
      makeMinimalContract(),
    );
    analyzer.initialize();

    expect((analyzer as any).contractMatcher).toBeDefined();
    expect((analyzer as any).program).toBeDefined();
  });
});
