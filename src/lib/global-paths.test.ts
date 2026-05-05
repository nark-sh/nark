import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  encodeProjectPath,
  getNarkProjectDir,
  getNarkScansDir,
  getNarkViolationsDir,
  getNarkRunsDir,
  getNarkGeneratedTsconfig,
  getNarkInitConfig,
  getNarkSuppressionsManifest,
} from './global-paths.js';

describe('global-paths', () => {
  let tmpHome: string;
  let originalHome: string | undefined;

  beforeEach(() => {
    // Create an isolated temp HOME for each test so we don't pollute the real
    // ~/.nark/projects/ tree.
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'nark-global-paths-test-'));
    originalHome = process.env.HOME;
    process.env.HOME = tmpHome;
  });

  afterEach(() => {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    try {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  describe('encodeProjectPath', () => {
    it('encodes a typical absolute path with leading dash and slashes replaced', () => {
      expect(encodeProjectPath('/Users/calebgates/foo/bar')).toBe(
        '-Users-calebgates-foo-bar'
      );
    });

    it('encodes the root path as a single dash', () => {
      expect(encodeProjectPath('/')).toBe('-');
    });

    it('resolves relative paths to absolute before encoding', () => {
      const expected = path.resolve('foo/bar').replace(/\//g, '-');
      expect(encodeProjectPath('foo/bar')).toBe(expected);
      // Resolved absolute path always begins with '/' so encoded begins with '-'
      expect(encodeProjectPath('foo/bar').startsWith('-')).toBe(true);
    });

    it('produces stable output for the same input', () => {
      const a = encodeProjectPath('/Users/calebgates/foo/bar');
      const b = encodeProjectPath('/Users/calebgates/foo/bar');
      expect(a).toBe(b);
    });
  });

  describe('getNarkProjectDir', () => {
    it('returns os.homedir()/.nark/projects/<encoded>', () => {
      const projectRoot = '/Users/test/project';
      const dir = getNarkProjectDir(projectRoot);
      const expected = path.join(
        os.homedir(),
        '.nark',
        'projects',
        encodeProjectPath(projectRoot)
      );
      expect(dir).toBe(expected);
    });

    it('creates the directory on first call', () => {
      const projectRoot = '/Users/test/project';
      const dir = getNarkProjectDir(projectRoot);
      expect(fs.existsSync(dir)).toBe(true);
      expect(fs.statSync(dir).isDirectory()).toBe(true);
    });

    it('is idempotent — safe to call repeatedly', () => {
      const projectRoot = '/Users/test/project';
      const a = getNarkProjectDir(projectRoot);
      const b = getNarkProjectDir(projectRoot);
      const c = getNarkProjectDir(projectRoot);
      expect(a).toBe(b);
      expect(b).toBe(c);
      expect(fs.existsSync(a)).toBe(true);
    });
  });

  describe('getNarkScansDir', () => {
    it('returns project dir + /scans and creates it', () => {
      const projectRoot = '/Users/test/project';
      const scansDir = getNarkScansDir(projectRoot);
      expect(scansDir).toBe(path.join(getNarkProjectDir(projectRoot), 'scans'));
      expect(fs.existsSync(scansDir)).toBe(true);
      expect(fs.statSync(scansDir).isDirectory()).toBe(true);
    });
  });

  describe('getNarkViolationsDir', () => {
    it('returns project dir + /violations and creates it', () => {
      const projectRoot = '/Users/test/project';
      const violationsDir = getNarkViolationsDir(projectRoot);
      expect(violationsDir).toBe(
        path.join(getNarkProjectDir(projectRoot), 'violations')
      );
      expect(fs.existsSync(violationsDir)).toBe(true);
      expect(fs.statSync(violationsDir).isDirectory()).toBe(true);
    });
  });

  describe('getNarkRunsDir', () => {
    it('returns project dir + /runs and creates it', () => {
      const projectRoot = '/Users/test/project';
      const runsDir = getNarkRunsDir(projectRoot);
      expect(runsDir).toBe(path.join(getNarkProjectDir(projectRoot), 'runs'));
      expect(fs.existsSync(runsDir)).toBe(true);
      expect(fs.statSync(runsDir).isDirectory()).toBe(true);
    });
  });

  describe('getNarkGeneratedTsconfig', () => {
    it('returns project dir + /tsconfig.json with parent dir created (file NOT pre-created)', () => {
      const projectRoot = '/Users/test/project';
      const tsconfigPath = getNarkGeneratedTsconfig(projectRoot);
      expect(tsconfigPath).toBe(
        path.join(getNarkProjectDir(projectRoot), 'tsconfig.json')
      );
      // Parent exists
      expect(fs.existsSync(path.dirname(tsconfigPath))).toBe(true);
      // File itself is NOT created
      expect(fs.existsSync(tsconfigPath)).toBe(false);
    });
  });

  describe('getNarkInitConfig', () => {
    it('returns project dir + /config.json with parent dir created (file NOT pre-created)', () => {
      const projectRoot = '/Users/test/project';
      const configPath = getNarkInitConfig(projectRoot);
      expect(configPath).toBe(
        path.join(getNarkProjectDir(projectRoot), 'config.json')
      );
      expect(fs.existsSync(path.dirname(configPath))).toBe(true);
      expect(fs.existsSync(configPath)).toBe(false);
    });
  });

  describe('getNarkSuppressionsManifest', () => {
    it('returns project dir + /suppressions.json with parent dir created (file NOT pre-created)', () => {
      const projectRoot = '/Users/test/project';
      const manifestPath = getNarkSuppressionsManifest(projectRoot);
      expect(manifestPath).toBe(
        path.join(getNarkProjectDir(projectRoot), 'suppressions.json')
      );
      expect(fs.existsSync(path.dirname(manifestPath))).toBe(true);
      expect(fs.existsSync(manifestPath)).toBe(false);
    });
  });
});
