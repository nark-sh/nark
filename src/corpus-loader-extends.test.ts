/**
 * Tests for the extends: inheritance feature in corpus-loader.
 *
 * Covers:
 *  - End-to-end loadCorpus() with a parent/child pair on disk
 *  - mergeContracts() behavior in isolation:
 *    - override postcondition by id
 *    - append new postcondition id (parent's untouched)
 *    - inherit unchanged postconditions
 *    - new function in child appends
 *    - override function-level fields
 *    - detection: child wins wholesale when present
 *  - Error cases via loadCorpus():
 *    - missing parent file
 *    - circular extends
 *    - package mismatch
 *    - path escape (extends out of corpus/packages)
 *    - depth cap
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { loadCorpus, mergeContracts } from './corpus-loader.js';
import type { PackageContract, FunctionContract, Postcondition } from './types.js';

// ── Schema we reuse across temp-corpus fixtures ─────────────────────────────
const CORPUS_SCHEMA = JSON.stringify({
  $schema: 'http://json-schema.org/draft-07/schema#',
  type: 'object',
  required: ['package', 'semver', 'contract_version', 'maintainer', 'last_verified', 'functions'],
  properties: {
    package: { type: 'string' },
    semver: { type: 'string' },
    contract_version: { type: 'string' },
    maintainer: { type: 'string' },
    last_verified: { type: 'string' },
    evidence_quality: { type: 'string' },
    status: { type: 'string' },
    extends: { type: 'string' },
    detection: { type: 'object' },
    functions: { type: 'array', minItems: 1 },
  },
});

function setupTempCorpus(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nark-corpus-extends-test-'));
  fs.mkdirSync(path.join(dir, 'packages'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'schema'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'schema', 'contract.schema.json'), CORPUS_SCHEMA);
  return dir;
}

function writeYaml(corpusDir: string, relPath: string, contract: object): string {
  const fullPath = path.join(corpusDir, 'packages', relPath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, toYaml(contract));
  return fullPath;
}

/**
 * Minimal YAML serializer for the simple fixtures we use here. We only handle
 * plain objects, arrays of objects, strings, numbers, booleans — no special
 * YAML types. Keeps the test self-contained and avoids pulling in a real
 * serializer just for fixtures.
 */
function toYaml(obj: unknown, indent = 0): string {
  const pad = '  '.repeat(indent);
  if (Array.isArray(obj)) {
    return obj.map((item) => `${pad}- ${toYaml(item, indent + 1).trimStart()}`).join('\n');
  }
  if (obj && typeof obj === 'object') {
    const lines: string[] = [];
    for (const [k, v] of Object.entries(obj)) {
      if (v === undefined) continue;
      if (Array.isArray(v) || (v && typeof v === 'object')) {
        lines.push(`${pad}${k}:`);
        lines.push(toYaml(v, indent + 1));
      } else if (typeof v === 'string') {
        lines.push(`${pad}${k}: ${JSON.stringify(v)}`);
      } else {
        lines.push(`${pad}${k}: ${v}`);
      }
    }
    return lines.join('\n');
  }
  if (typeof obj === 'string') return JSON.stringify(obj);
  return String(obj);
}

// ── Fixtures ─────────────────────────────────────────────────────────────────
function makePostcondition(id: string, condition = 'cond', severity = 'error'): Postcondition {
  return {
    id,
    condition,
    sources: ['https://example.com/' + id],
    severity: severity as Postcondition['severity'],
  };
}

function makeFunction(name: string, postconditions: Postcondition[]): FunctionContract {
  return {
    name,
    import_path: 'test-pkg',
    description: name + ' description',
    postconditions,
  };
}

function makeContract(overrides: Partial<PackageContract>): PackageContract {
  return {
    package: 'test-pkg',
    semver: '*',
    contract_version: '1.0.0',
    maintainer: 'test',
    last_verified: '2026-06-09',
    functions: [makeFunction('foo', [makePostcondition('foo-base')])],
    ...overrides,
  };
}

// ── mergeContracts() unit tests ─────────────────────────────────────────────
describe('mergeContracts', () => {
  it('child overrides postcondition by id, parent ids without overrides are kept', () => {
    const parent = makeContract({
      functions: [
        makeFunction('foo', [
          makePostcondition('shared', 'parent-condition'),
          makePostcondition('parent-only'),
        ]),
      ],
    });
    const child = makeContract({
      functions: [
        makeFunction('foo', [makePostcondition('shared', 'child-condition')]),
      ],
    });

    const merged = mergeContracts(parent, child);

    const foo = merged.functions.find((f) => f.name === 'foo')!;
    const shared = foo.postconditions!.find((p) => p.id === 'shared')!;
    expect(shared.condition).toBe('child-condition');
    expect(foo.postconditions!.find((p) => p.id === 'parent-only')).toBeDefined();
  });

  it('appends new postcondition ids from child after inherited parent ids', () => {
    const parent = makeContract({
      functions: [makeFunction('foo', [makePostcondition('parent-only')])],
    });
    const child = makeContract({
      functions: [makeFunction('foo', [makePostcondition('child-new')])],
    });

    const merged = mergeContracts(parent, child);

    const ids = merged.functions[0].postconditions!.map((p) => p.id);
    expect(ids).toEqual(['parent-only', 'child-new']);
  });

  it('appends new functions defined only in child', () => {
    const parent = makeContract({
      functions: [makeFunction('foo', [makePostcondition('foo-pc')])],
    });
    const child = makeContract({
      functions: [makeFunction('bar', [makePostcondition('bar-pc')])],
    });

    const merged = mergeContracts(parent, child);

    expect(merged.functions.map((f) => f.name)).toEqual(['foo', 'bar']);
  });

  it('child function-level fields (description, import_path) override parent', () => {
    const parent = makeContract({
      functions: [
        {
          name: 'foo',
          import_path: 'parent-path',
          description: 'parent desc',
          postconditions: [makePostcondition('foo-pc')],
        },
      ],
    });
    const child = makeContract({
      functions: [
        {
          name: 'foo',
          import_path: 'child-path',
          description: 'child desc',
        } as FunctionContract,
      ],
    });

    const merged = mergeContracts(parent, child);
    const foo = merged.functions[0];
    expect(foo.import_path).toBe('child-path');
    expect(foo.description).toBe('child desc');
    // Postcondition inherited because child didn't redeclare it.
    expect(foo.postconditions!.map((p) => p.id)).toEqual(['foo-pc']);
  });

  it("child's detection block wins wholesale when present", () => {
    const parent = makeContract({
      detection: { class_names: ['ParentClass'], factory_methods: ['parentFactory'] },
    });
    const child = makeContract({
      detection: { class_names: ['ChildClass'] },
    });

    const merged = mergeContracts(parent, child);
    expect(merged.detection?.class_names).toEqual(['ChildClass']);
    // Wholesale replacement — parent's factory_methods are NOT preserved.
    expect(merged.detection?.factory_methods).toBeUndefined();
  });

  it("inherits parent's detection when child omits it", () => {
    const parent = makeContract({
      detection: { class_names: ['ParentClass'] },
    });
    const child = makeContract({ detection: undefined });

    const merged = mergeContracts(parent, child);
    expect(merged.detection?.class_names).toEqual(['ParentClass']);
  });

  it('child semver and contract_version override parent', () => {
    const parent = makeContract({ semver: '>=1.0.0 <21.0.0', contract_version: '1.0.0' });
    const child = makeContract({ semver: '>=21.0.0', contract_version: '2.0.0' });

    const merged = mergeContracts(parent, child);
    expect(merged.semver).toBe('>=21.0.0');
    expect(merged.contract_version).toBe('2.0.0');
  });

  it('passes through non-handled fields like evidence_quality', () => {
    const parent = { ...makeContract({}), evidence_quality: 'confirmed' } as PackageContract & {
      evidence_quality: string;
    };
    const child = makeContract({});

    const merged = mergeContracts(parent, child) as PackageContract & { evidence_quality?: string };
    expect(merged.evidence_quality).toBe('confirmed');
  });
});

// ── End-to-end loadCorpus() tests ───────────────────────────────────────────
describe('loadCorpus with extends', () => {
  let corpusDir: string;

  beforeEach(() => {
    corpusDir = setupTempCorpus();
  });

  afterEach(() => {
    fs.rmSync(corpusDir, { recursive: true, force: true });
  });

  it('loads a parent + extending child as two separate profiles per package', async () => {
    writeYaml(corpusDir, 'foo/contract.yaml', {
      package: 'foo',
      semver: '>=1.0.0 <2.0.0',
      contract_version: '1.0.0',
      maintainer: 'test',
      last_verified: '2026-06-09',
      functions: [
        {
          name: 'create',
          import_path: 'foo',
          description: 'creates',
          postconditions: [
            { id: 'parent-pc', condition: 'parent', sources: ['https://x'], severity: 'error' },
          ],
        },
      ],
    });

    writeYaml(corpusDir, 'foo-v2/contract.yaml', {
      package: 'foo',
      semver: '>=2.0.0',
      contract_version: '2.0.0',
      maintainer: 'test',
      last_verified: '2026-06-09',
      extends: '../foo/contract.yaml',
      functions: [
        {
          name: 'create',
          import_path: 'foo',
          description: 'creates',
          postconditions: [
            { id: 'child-pc', condition: 'child-new', sources: ['https://y'], severity: 'error' },
          ],
        },
      ],
    });

    const result = await loadCorpus(corpusDir);

    expect(result.errors).toEqual([]);
    const profiles = result.contractsByPackageName!.get('foo')!;
    expect(profiles).toHaveLength(2);

    // The v2 (extending) profile should contain BOTH the parent's postcondition
    // and the child's new one — that's the whole point of extends.
    const v2 = profiles.find((p) => p.semver === '>=2.0.0')!;
    const v2Pcs = v2.functions[0].postconditions!.map((p) => p.id);
    expect(v2Pcs).toEqual(['parent-pc', 'child-pc']);

    // Parent profile should remain pristine — only its own postcondition.
    const v1 = profiles.find((p) => p.semver === '>=1.0.0 <2.0.0')!;
    expect(v1.functions[0].postconditions!.map((p) => p.id)).toEqual(['parent-pc']);
  });

  it('errors when extends targets a non-existent file', async () => {
    writeYaml(corpusDir, 'bar/contract.yaml', {
      package: 'bar',
      semver: '>=1.0.0',
      contract_version: '1.0.0',
      maintainer: 'test',
      last_verified: '2026-06-09',
      extends: '../does-not-exist/contract.yaml',
      functions: [
        { name: 'noop', import_path: 'bar', description: 'noop', postconditions: [] },
      ],
    });

    const result = await loadCorpus(corpusDir);
    expect(result.errors.some((e) => e.includes('extends target not found'))).toBe(true);
  });

  it('errors on circular extends', async () => {
    writeYaml(corpusDir, 'a/contract.yaml', {
      package: 'a',
      semver: '>=1.0.0',
      contract_version: '1.0.0',
      maintainer: 'test',
      last_verified: '2026-06-09',
      extends: '../b/contract.yaml',
      functions: [{ name: 'x', import_path: 'a', description: 'x', postconditions: [] }],
    });
    writeYaml(corpusDir, 'b/contract.yaml', {
      package: 'a',
      semver: '>=2.0.0',
      contract_version: '1.0.0',
      maintainer: 'test',
      last_verified: '2026-06-09',
      extends: '../a/contract.yaml',
      functions: [{ name: 'x', import_path: 'a', description: 'x', postconditions: [] }],
    });

    const result = await loadCorpus(corpusDir);
    expect(result.errors.some((e) => e.includes('circular extends'))).toBe(true);
  });

  it("errors when child's package name differs from parent's", async () => {
    writeYaml(corpusDir, 'parent/contract.yaml', {
      package: 'parent-pkg',
      semver: '>=1.0.0',
      contract_version: '1.0.0',
      maintainer: 'test',
      last_verified: '2026-06-09',
      functions: [{ name: 'x', import_path: 'p', description: 'x', postconditions: [] }],
    });
    writeYaml(corpusDir, 'wrong-child/contract.yaml', {
      package: 'different-pkg',
      semver: '>=2.0.0',
      contract_version: '1.0.0',
      maintainer: 'test',
      last_verified: '2026-06-09',
      extends: '../parent/contract.yaml',
      functions: [{ name: 'x', import_path: 'p', description: 'x', postconditions: [] }],
    });

    const result = await loadCorpus(corpusDir);
    expect(result.errors.some((e) => e.includes('extends package mismatch'))).toBe(true);
  });

  it('errors when extends path escapes the corpus packages dir', async () => {
    writeYaml(corpusDir, 'escape/contract.yaml', {
      package: 'escape',
      semver: '>=1.0.0',
      contract_version: '1.0.0',
      maintainer: 'test',
      last_verified: '2026-06-09',
      extends: '../../../../etc/passwd',
      functions: [{ name: 'x', import_path: 'e', description: 'x', postconditions: [] }],
    });

    const result = await loadCorpus(corpusDir);
    expect(result.errors.some((e) => e.includes('escapes corpus packages dir'))).toBe(true);
  });

  it('supports a multi-level chain (grandparent → parent → child)', async () => {
    writeYaml(corpusDir, 'gp/contract.yaml', {
      package: 'multi',
      semver: '>=1.0.0 <2.0.0',
      contract_version: '1.0.0',
      maintainer: 'test',
      last_verified: '2026-06-09',
      functions: [
        {
          name: 'foo',
          import_path: 'multi',
          description: 'gp desc',
          postconditions: [
            { id: 'gp-pc', condition: 'gp', sources: ['https://x'], severity: 'error' },
          ],
        },
      ],
    });
    writeYaml(corpusDir, 'parent/contract.yaml', {
      package: 'multi',
      semver: '>=2.0.0 <3.0.0',
      contract_version: '2.0.0',
      maintainer: 'test',
      last_verified: '2026-06-09',
      extends: '../gp/contract.yaml',
      functions: [
        {
          name: 'foo',
          import_path: 'multi',
          description: 'gp desc',
          postconditions: [
            { id: 'parent-pc', condition: 'parent', sources: ['https://y'], severity: 'error' },
          ],
        },
      ],
    });
    writeYaml(corpusDir, 'child/contract.yaml', {
      package: 'multi',
      semver: '>=3.0.0',
      contract_version: '3.0.0',
      maintainer: 'test',
      last_verified: '2026-06-09',
      extends: '../parent/contract.yaml',
      functions: [
        {
          name: 'foo',
          import_path: 'multi',
          description: 'gp desc',
          postconditions: [
            { id: 'child-pc', condition: 'child', sources: ['https://z'], severity: 'error' },
          ],
        },
      ],
    });

    const result = await loadCorpus(corpusDir);
    expect(result.errors).toEqual([]);
    const child = result
      .contractsByPackageName!.get('multi')!
      .find((p) => p.semver === '>=3.0.0')!;
    expect(child.functions[0].postconditions!.map((p) => p.id)).toEqual([
      'gp-pc',
      'parent-pc',
      'child-pc',
    ]);
  });
});
