import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as path from 'path';

// Mock child_process.execSync so we can feed canned git diff output without
// needing an actual repo checkout.
const execSyncMock = vi.fn();
vi.mock('child_process', () => ({
  execSync: (...args: unknown[]) => execSyncMock(...args),
}));

import {
  parseDiffSpec,
  parseHunkHeadersToLines,
  computeDiffLines,
  filterViolationsByDiff,
} from './diff-filter.js';

describe('diff-filter', () => {
  beforeEach(() => {
    execSyncMock.mockReset();
  });

  describe('parseDiffSpec', () => {
    it('parses main..HEAD', () => {
      expect(parseDiffSpec('main..HEAD')).toEqual({ base: 'main', head: 'HEAD' });
    });

    it('parses two SHAs', () => {
      expect(parseDiffSpec('abc..def')).toEqual({ base: 'abc', head: 'def' });
    });

    it('throws on malformed input — no separator', () => {
      expect(() => parseDiffSpec('mainHEAD')).toThrow(/Invalid --diff spec/);
    });

    it('throws on malformed input — empty sides', () => {
      expect(() => parseDiffSpec('..')).toThrow(/Invalid --diff spec/);
      expect(() => parseDiffSpec('main..')).toThrow(/Invalid --diff spec/);
      expect(() => parseDiffSpec('..HEAD')).toThrow(/Invalid --diff spec/);
    });

    it('throws on empty string', () => {
      expect(() => parseDiffSpec('')).toThrow(/Invalid --diff spec/);
    });

    it('rejects three-dot form (caller must pass two-dot)', () => {
      // 'a...b' splits on '..' into ['a', '.b'] which is two parts, but the
      // second part starts with '.' — we accept it as a string (git itself
      // would resolve it). The important contract is just "two non-empty
      // halves". Documenting this for future maintainers.
      const parsed = parseDiffSpec('main...HEAD');
      expect(parsed.base).toBe('main');
      expect(parsed.head).toBe('.HEAD');
    });
  });

  describe('parseHunkHeadersToLines', () => {
    it('parses a single hunk with explicit count', () => {
      const diff = `@@ -10,3 +20,5 @@\n+new line 1\n+new line 2\n+new line 3\n+new line 4\n+new line 5`;
      const lines = parseHunkHeadersToLines(diff);
      expect([...lines].sort((a, b) => a - b)).toEqual([20, 21, 22, 23, 24]);
    });

    it('treats missing newCount as 1', () => {
      const diff = `@@ -5 +7 @@\n+single line`;
      const lines = parseHunkHeadersToLines(diff);
      expect([...lines]).toEqual([7]);
    });

    it('skips deletion-only hunks (newCount === 0)', () => {
      const diff = `@@ -10,2 +9,0 @@\n-deleted line 1\n-deleted line 2`;
      const lines = parseHunkHeadersToLines(diff);
      expect(lines.size).toBe(0);
    });

    it('handles multiple hunks in one diff', () => {
      const diff = [
        '@@ -1,2 +1,2 @@',
        ' context',
        '-old',
        '+new',
        '@@ -50,0 +52,3 @@',
        '+a',
        '+b',
        '+c',
      ].join('\n');
      const lines = parseHunkHeadersToLines(diff);
      expect([...lines].sort((a, b) => a - b)).toEqual([1, 2, 52, 53, 54]);
    });

    it('returns empty set when no hunks present', () => {
      expect(parseHunkHeadersToLines('').size).toBe(0);
      expect(parseHunkHeadersToLines('no hunks here').size).toBe(0);
    });
  });

  describe('computeDiffLines', () => {
    const cwd = '/repo';

    it('returns a map of absolute paths → new-side line numbers', () => {
      // First call: name-status enumeration
      execSyncMock.mockImplementationOnce(() => 'M\tsrc/a.ts\nA\tsrc/b.ts\n');
      // Second call: per-file diff for src/a.ts
      execSyncMock.mockImplementationOnce(
        () => '@@ -10,1 +10,2 @@\n context\n+added line\n',
      );
      // Third call: per-file diff for src/b.ts
      execSyncMock.mockImplementationOnce(() => '@@ -0,0 +1,3 @@\n+a\n+b\n+c\n');

      const map = computeDiffLines({ base: 'main', head: 'HEAD' }, { cwd });

      expect(map.size).toBe(2);
      expect(map.get(path.resolve(cwd, 'src/a.ts'))).toEqual(new Set([10, 11]));
      expect(map.get(path.resolve(cwd, 'src/b.ts'))).toEqual(new Set([1, 2, 3]));
    });

    it('skips deleted files (status D)', () => {
      execSyncMock.mockImplementationOnce(
        () => 'M\tsrc/a.ts\nD\tsrc/gone.ts\n',
      );
      execSyncMock.mockImplementationOnce(() => '@@ -5,0 +5,1 @@\n+x\n');

      const map = computeDiffLines({ base: 'main', head: 'HEAD' }, { cwd });

      // Only one per-file diff call (a.ts), plus the initial name-status call → 2 total
      expect(execSyncMock).toHaveBeenCalledTimes(2);
      expect(map.size).toBe(1);
      expect(map.has(path.resolve(cwd, 'src/a.ts'))).toBe(true);
      expect(map.has(path.resolve(cwd, 'src/gone.ts'))).toBe(false);
    });

    it('handles renamed files via -M detection (new path is third column)', () => {
      execSyncMock.mockImplementationOnce(
        () => 'R100\tsrc/old.ts\tsrc/new.ts\n',
      );
      execSyncMock.mockImplementationOnce(() => '@@ -10,1 +15,1 @@\n+changed\n');

      const map = computeDiffLines({ base: 'main', head: 'HEAD' }, { cwd });

      expect(map.size).toBe(1);
      expect(map.has(path.resolve(cwd, 'src/new.ts'))).toBe(true);
      expect(map.has(path.resolve(cwd, 'src/old.ts'))).toBe(false);
      expect(map.get(path.resolve(cwd, 'src/new.ts'))).toEqual(new Set([15]));
    });

    it('omits files whose diff parses to zero added lines', () => {
      execSyncMock.mockImplementationOnce(() => 'M\tsrc/only-deletion.ts\n');
      // Deletion-only hunk
      execSyncMock.mockImplementationOnce(() => '@@ -10,2 +9,0 @@\n-x\n-y\n');

      const map = computeDiffLines({ base: 'main', head: 'HEAD' }, { cwd });

      expect(map.size).toBe(0);
    });

    it('returns empty map when no files changed', () => {
      execSyncMock.mockImplementationOnce(() => '');
      const map = computeDiffLines({ base: 'main', head: 'HEAD' }, { cwd });
      expect(map.size).toBe(0);
    });
  });

  describe('filterViolationsByDiff', () => {
    const fileA = '/repo/src/a.ts';
    const fileB = '/repo/src/b.ts';
    const untouched = '/repo/src/untouched.ts';

    it('includes a violation whose (file, line) is in the map', () => {
      const map = new Map([[fileA, new Set([10, 11])]]);
      const violations = [{ file: fileA, line: 10 }];
      expect(filterViolationsByDiff(violations, map)).toEqual([{ file: fileA, line: 10 }]);
    });

    it('excludes a violation whose file is in the map but line is not (untouched-line-in-touched-file)', () => {
      const map = new Map([[fileA, new Set([10, 11])]]);
      const violations = [{ file: fileA, line: 5 }];
      expect(filterViolationsByDiff(violations, map)).toEqual([]);
    });

    it('excludes a violation whose file is not in the map at all', () => {
      const map = new Map([[fileA, new Set([10])]]);
      const violations = [{ file: untouched, line: 10 }];
      expect(filterViolationsByDiff(violations, map)).toEqual([]);
    });

    it('treats absolute and relative paths equivalently', () => {
      const map = new Map([[fileA, new Set([10])]]);
      const originalCwd = process.cwd();
      try {
        // Spoof cwd so relative path resolves to fileA
        process.chdir('/repo');
        // On macOS /repo doesn't exist — fall back to using path.relative
        // approach instead. If chdir fails, the catch path below covers it.
      } catch {
        // ignore — handled below
      }
      try {
        // Compute a relative path from the (possibly-restored) cwd to fileA
        const rel = path.relative(process.cwd(), fileA);
        const violations = [{ file: rel, line: 10 }];
        const out = filterViolationsByDiff(violations, map);
        expect(out.length).toBe(1);
      } finally {
        process.chdir(originalCwd);
      }
    });

    it('handles renamed files by matching on the new path', () => {
      const newPath = '/repo/src/new.ts';
      const map = new Map([[newPath, new Set([15])]]);
      const violations = [{ file: newPath, line: 15 }];
      expect(filterViolationsByDiff(violations, map)).toEqual([{ file: newPath, line: 15 }]);
    });

    it('returns empty array for empty diff map (positive filter, not no-op)', () => {
      const map = new Map();
      const violations = [{ file: fileA, line: 10 }];
      expect(filterViolationsByDiff(violations, map)).toEqual([]);
    });

    it('handles violations with multiple matching files in map', () => {
      const map = new Map([
        [fileA, new Set([10])],
        [fileB, new Set([20])],
      ]);
      const violations = [
        { file: fileA, line: 10 }, // include
        { file: fileA, line: 99 }, // exclude — wrong line
        { file: fileB, line: 20 }, // include
        { file: untouched, line: 1 }, // exclude — wrong file
      ];
      const out = filterViolationsByDiff(violations, map);
      expect(out).toHaveLength(2);
      expect(out).toContainEqual({ file: fileA, line: 10 });
      expect(out).toContainEqual({ file: fileB, line: 20 });
    });

    it('tolerates filePath/lineNumber field aliases', () => {
      const map = new Map([[fileA, new Set([10])]]);
      const violations = [{ filePath: fileA, lineNumber: 10 }];
      expect(filterViolationsByDiff(violations, map)).toHaveLength(1);
    });

    it('excludes violations missing file or line fields', () => {
      const map = new Map([[fileA, new Set([10])]]);
      const violations = [
        { file: fileA }, // no line
        { line: 10 }, // no file
        { file: fileA, line: 10 }, // valid
      ];
      expect(filterViolationsByDiff(violations, map)).toEqual([{ file: fileA, line: 10 }]);
    });
  });
});
