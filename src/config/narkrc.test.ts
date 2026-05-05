/**
 * Tests for loadNarkRc()
 *
 * Tests config file discovery, YAML parsing, git root boundary,
 * and error handling. Reads .nark/config.yaml only.
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

// Helper: write a .nark/config.yaml at the given dir (mkdirs the .nark folder first)
function writeNarkConfig(dir: string, contents: string): void {
  fs.mkdirSync(path.join(dir, '.nark'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.nark', 'config.yaml'), contents);
}

describe('loadNarkRc', () => {
  it('returns null when no config file exists anywhere', () => {
    makeGitRoot(tmpDir);
    const subdir = makeSubdir(tmpDir, 'src');
    expect(loadNarkRc(subdir)).toBeNull();
  });

  it('returns parsed NarkRcConfig from .nark/config.yaml in projectRoot', () => {
    makeGitRoot(tmpDir);
    writeNarkConfig(tmpDir, 'failThreshold: warning\n');
    const result = loadNarkRc(tmpDir);
    expect(result).toEqual({ failThreshold: 'warning' });
  });

  it('traverses up to parent directory to find .nark/config.yaml', () => {
    makeGitRoot(tmpDir);
    const subdir = makeSubdir(tmpDir, 'packages', 'my-app');
    writeNarkConfig(tmpDir, 'includeDrafts: true\n');
    const result = loadNarkRc(subdir);
    expect(result).toEqual({ includeDrafts: true });
  });

  it('stops traversal at git root and does not go above it', () => {
    // Layout: tmpDir (no .git) / inner (has .git) / project
    // .nark/config.yaml is at tmpDir (above git root) — should NOT be found
    const inner = makeSubdir(tmpDir, 'inner');
    makeGitRoot(inner);
    const project = makeSubdir(inner, 'project');
    writeNarkConfig(tmpDir, 'failThreshold: info\n');
    expect(loadNarkRc(project)).toBeNull();
  });

  it('throws a descriptive error for invalid YAML', () => {
    makeGitRoot(tmpDir);
    writeNarkConfig(tmpDir, 'key: [unclosed bracket\n');
    expect(() => loadNarkRc(tmpDir)).toThrow(/\.nark[\\/]config\.yaml/);
  });

  it('silently ignores unknown keys in YAML', () => {
    makeGitRoot(tmpDir);
    writeNarkConfig(tmpDir, 'unknownKey: someValue\nfailThreshold: warning\n');
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
    writeNarkConfig(tmpDir, yaml);
    const result = loadNarkRc(tmpDir);
    expect(result?.tsconfig).toBe('./tsconfig.json');
    expect(result?.corpus).toBe('../nark-corpus');
    expect(result?.output?.json).toBe('.nark/latest.json');
    expect(result?.output?.sarif).toBe('.nark/results.sarif');
  });

  it('returns null when git root directory itself is checked and has no config', () => {
    makeGitRoot(tmpDir);
    // No .nark/config.yaml anywhere
    expect(loadNarkRc(tmpDir)).toBeNull();
  });
});
