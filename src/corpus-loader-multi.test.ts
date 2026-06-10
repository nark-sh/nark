/**
 * Tests for loadMultipleCorpora() — multi-corpus loading with precedence.
 *
 * Covers:
 *  - Single-corpus fast path: behavior matches loadCorpus
 *  - Two corpora, no overlap: both load, no warnings
 *  - Two corpora, package-name overlap: higher precedence wins, warning emitted
 *  - Three corpora chain (private > pro > public): full precedence enforced
 *  - Missing corpus path: silently skipped, others still load
 *  - All corpora missing: error returned, no crash
 *  - corpusSources populated correctly with winning path per package
 *  - searchedPaths reflects input order
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { loadMultipleCorpora } from './corpus-loader.js';

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
    functions: { type: 'array', minItems: 1 },
  },
});

function setupTempCorpus(label: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `nark-multi-${label}-`));
  fs.mkdirSync(path.join(dir, 'packages'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'schema'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'schema', 'contract.schema.json'), CORPUS_SCHEMA);
  return dir;
}

function writePackage(corpusDir: string, pkgName: string, marker: string): void {
  const pkgDir = path.join(corpusDir, 'packages', pkgName);
  fs.mkdirSync(pkgDir, { recursive: true });
  const yaml = [
    `package: "${pkgName}"`,
    'semver: "*"',
    'contract_version: "1.0.0"',
    `maintainer: "${marker}"`,
    'last_verified: "2026-06-10"',
    'evidence_quality: "confirmed"',
    'functions:',
    '  - name: "doThing"',
    `    import_path: "${pkgName}"`,
    `    description: "${marker} description"`,
    '    postconditions:',
    `      - id: "${marker}-p1"`,
    `        condition: "${marker} condition"`,
    '        sources: ["https://example.com/p1"]',
    '        severity: "error"',
  ].join('\n');
  fs.writeFileSync(path.join(pkgDir, 'contract.yaml'), yaml);
}

const tempDirs: string[] = [];

afterEach(() => {
  for (const d of tempDirs) {
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
  tempDirs.length = 0;
});

function makeCorpus(label: string): string {
  const dir = setupTempCorpus(label);
  tempDirs.push(dir);
  return dir;
}

describe('loadMultipleCorpora', () => {
  it('single-corpus fast path returns expected shape', async () => {
    const corpus = makeCorpus('single');
    writePackage(corpus, 'pkg-a', 'public');

    const result = await loadMultipleCorpora([corpus]);

    expect(result.errors).toEqual([]);
    expect(result.contracts.has('pkg-a')).toBe(true);
    expect(result.searchedPaths).toEqual([corpus]);
    expect(result.corpusSources).toBeUndefined();
  });

  it('two corpora, no overlap: both load, no overlap warnings', async () => {
    const pro = makeCorpus('pro');
    const pub = makeCorpus('pub');
    writePackage(pro, 'pkg-pro-only', 'pro');
    writePackage(pub, 'pkg-pub-only', 'public');

    const result = await loadMultipleCorpora([pro, pub]);

    expect(result.errors).toEqual([]);
    expect(result.contracts.has('pkg-pro-only')).toBe(true);
    expect(result.contracts.has('pkg-pub-only')).toBe(true);
    expect(result.corpusSources?.get('pkg-pro-only')).toBe(pro);
    expect(result.corpusSources?.get('pkg-pub-only')).toBe(pub);

    const overlapWarnings = (result.warnings ?? []).filter((w) =>
      w.includes('overrides profile from')
    );
    expect(overlapWarnings).toEqual([]);
  });

  it('two corpora with package-name overlap: higher precedence wins + warning fires', async () => {
    const pro = makeCorpus('pro');
    const pub = makeCorpus('pub');
    writePackage(pro, 'pkg-shared', 'pro');
    writePackage(pub, 'pkg-shared', 'public');

    const result = await loadMultipleCorpora([pro, pub]);

    expect(result.errors).toEqual([]);
    expect(result.contracts.get('pkg-shared')?.maintainer).toBe('pro');
    expect(result.corpusSources?.get('pkg-shared')).toBe(pro);

    const overrideWarnings = (result.warnings ?? []).filter((w) =>
      w.includes('overrides profile from')
    );
    expect(overrideWarnings.length).toBe(1);
    expect(overrideWarnings[0]).toContain('pkg-shared');
    expect(overrideWarnings[0]).toContain(pro);
    expect(overrideWarnings[0]).toContain(pub);
  });

  it('three corpora chain: private > pro > public', async () => {
    const priv = makeCorpus('priv');
    const pro = makeCorpus('pro');
    const pub = makeCorpus('pub');
    writePackage(priv, 'pkg-shared', 'private');
    writePackage(pro, 'pkg-shared', 'pro');
    writePackage(pub, 'pkg-shared', 'public');
    writePackage(pub, 'pkg-only-public', 'public');

    const result = await loadMultipleCorpora([priv, pro, pub]);

    expect(result.errors).toEqual([]);
    expect(result.contracts.get('pkg-shared')?.maintainer).toBe('private');
    expect(result.corpusSources?.get('pkg-shared')).toBe(priv);
    expect(result.contracts.get('pkg-only-public')?.maintainer).toBe('public');
    expect(result.corpusSources?.get('pkg-only-public')).toBe(pub);
  });

  it('missing corpus path is silently skipped (others still load)', async () => {
    const pub = makeCorpus('pub');
    writePackage(pub, 'pkg-only-public', 'public');
    const nonexistent = path.join(os.tmpdir(), 'nark-multi-DOES-NOT-EXIST-' + Date.now());

    const result = await loadMultipleCorpora([nonexistent, pub]);

    expect(result.errors).toEqual([]);
    expect(result.contracts.has('pkg-only-public')).toBe(true);
    const noteOnMissing = (result.warnings ?? []).find((w) =>
      w.includes(nonexistent)
    );
    expect(noteOnMissing).toBeDefined();
  });

  it('all corpora missing: returns error, does not crash', async () => {
    const a = path.join(os.tmpdir(), 'nark-multi-missing-a-' + Date.now());
    const b = path.join(os.tmpdir(), 'nark-multi-missing-b-' + Date.now());

    const result = await loadMultipleCorpora([a, b]);

    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.contracts.size).toBe(0);
  });

  it('empty input returns error', async () => {
    const result = await loadMultipleCorpora([]);
    expect(result.errors).toEqual(['No corpus paths provided']);
    expect(result.contracts.size).toBe(0);
  });

  it('searchedPaths reflects input precedence order', async () => {
    const a = makeCorpus('a');
    const b = makeCorpus('b');
    writePackage(a, 'pkg', 'a');
    writePackage(b, 'pkg', 'b');

    const result = await loadMultipleCorpora([a, b]);

    expect(result.searchedPaths).toEqual([a, b]);
  });
});
