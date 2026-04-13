/**
 * Tests for loadNarkRc()
 *
 * Tests config file discovery, YAML/JSON parsing, git root boundary,
 * precedence rules, and error handling.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { loadNarkRc } from './narkrc.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'narkrc-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// Helper: create a fake git repo root by adding a .git dir
function makeGitRoot(dir: string): void {
  fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
}

// Helper: create a subdirectory inside a dir
function makeSubdir(base: string, ...parts: string[]): string {
  const p = path.join(base, ...parts);
  fs.mkdirSync(p, { recursive: true });
  return p;
}

describe('loadNarkRc', () => {
  it('returns null when no config file exists anywhere', () => {
    makeGitRoot(tmpDir);
    const subdir = makeSubdir(tmpDir, 'src');
    expect(loadNarkRc(subdir)).toBeNull();
  });

  it('returns parsed NarkRcConfig from .narkrc.yaml in projectRoot', () => {
    makeGitRoot(tmpDir);
    fs.writeFileSync(path.join(tmpDir, '.narkrc.yaml'), 'failThreshold: warning\n');
    const result = loadNarkRc(tmpDir);
    expect(result).toEqual({ failThreshold: 'warning' });
  });

  it('returns parsed NarkRcConfig from .narkrc.json in projectRoot', () => {
    makeGitRoot(tmpDir);
    fs.writeFileSync(
      path.join(tmpDir, '.narkrc.json'),
      JSON.stringify({ corpus: '../nark-corpus' })
    );
    const result = loadNarkRc(tmpDir);
    expect(result).toEqual({ corpus: '../nark-corpus' });
  });

  it('traverses up to parent directory to find .narkrc.yaml', () => {
    makeGitRoot(tmpDir);
    const subdir = makeSubdir(tmpDir, 'packages', 'my-app');
    fs.writeFileSync(path.join(tmpDir, '.narkrc.yaml'), 'includeDrafts: true\n');
    const result = loadNarkRc(subdir);
    expect(result).toEqual({ includeDrafts: true });
  });

  it('stops traversal at git root and does not go above it', () => {
    // Layout: tmpDir (no .git) / inner (has .git) / project
    // .narkrc.yaml is at tmpDir (above git root) — should NOT be found
    const inner = makeSubdir(tmpDir, 'inner');
    makeGitRoot(inner);
    const project = makeSubdir(inner, 'project');
    fs.writeFileSync(path.join(tmpDir, '.narkrc.yaml'), 'failThreshold: info\n');
    expect(loadNarkRc(project)).toBeNull();
  });

  it('.narkrc.yaml takes precedence over .narkrc.json at same directory level', () => {
    makeGitRoot(tmpDir);
    fs.writeFileSync(path.join(tmpDir, '.narkrc.yaml'), 'failThreshold: warning\n');
    fs.writeFileSync(
      path.join(tmpDir, '.narkrc.json'),
      JSON.stringify({ failThreshold: 'info' })
    );
    const result = loadNarkRc(tmpDir);
    expect(result?.failThreshold).toBe('warning');
  });

  it('throws a descriptive error for invalid YAML', () => {
    makeGitRoot(tmpDir);
    fs.writeFileSync(path.join(tmpDir, '.narkrc.yaml'), 'key: [unclosed bracket\n');
    expect(() => loadNarkRc(tmpDir)).toThrow(/.narkrc.yaml/);
  });

  it('silently ignores unknown keys in YAML', () => {
    makeGitRoot(tmpDir);
    fs.writeFileSync(
      path.join(tmpDir, '.narkrc.yaml'),
      'unknownKey: someValue\nfailThreshold: warning\n'
    );
    const result = loadNarkRc(tmpDir);
    // Unknown keys should come through (no strict validation)
    expect(result?.failThreshold).toBe('warning');
  });

  it('returns full NarkRcConfig object with nested output field', () => {
    makeGitRoot(tmpDir);
    const yaml = [
      'tsconfig: ./tsconfig.json',
      'corpus: ../nark-corpus',
      'failThreshold: error',
      'output:',
      '  json: .nark/latest.json',
      '  sarif: .nark/results.sarif',
      'includeDrafts: false',
      'includeTests: false',
      'includeDeprecated: false',
      'telemetry: true',
    ].join('\n');
    fs.writeFileSync(path.join(tmpDir, '.narkrc.yaml'), yaml);
    const result = loadNarkRc(tmpDir);
    expect(result?.tsconfig).toBe('./tsconfig.json');
    expect(result?.corpus).toBe('../nark-corpus');
    expect(result?.output?.json).toBe('.nark/latest.json');
    expect(result?.output?.sarif).toBe('.nark/results.sarif');
  });

  it('returns null when git root directory itself is checked and has no config', () => {
    makeGitRoot(tmpDir);
    // No .narkrc.yaml anywhere
    expect(loadNarkRc(tmpDir)).toBeNull();
  });
});
