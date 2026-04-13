/**
 * Vitest tests for the SARIF 2.1.0 output writer.
 *
 * Validates structure, rule deduplication, severity mapping,
 * ruleId format, and file URI handling.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { writeSarifOutput } from '../../output/sarif-writer.js';
import type { Violation } from '../../types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeViolation(overrides: Partial<Violation> = {}): Violation {
  return {
    id: 'test-violation-1',
    severity: 'error',
    file: '/project/src/foo.ts',
    line: 10,
    column: 5,
    package: 'axios',
    function: 'axios.get',
    contract_clause: 'no-try-catch',
    description: 'Missing try-catch around axios.get call',
    source_doc: 'https://axios-http.com/docs/handling_errors',
    ...overrides,
  };
}

function writeTmp(violations: Violation[]): { filePath: string; log: any } {
  const filePath = path.join(os.tmpdir(), `sarif-test-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  writeSarifOutput(violations, filePath);
  const log = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  return { filePath, log };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('writeSarifOutput', () => {
  // Track tmp files for cleanup
  const tmpFiles: string[] = [];

  afterEach(() => {
    for (const f of tmpFiles) {
      try { fs.unlinkSync(f); } catch { /* ignore */ }
    }
    tmpFiles.length = 0;
  });

  it('empty violations produces valid SARIF envelope', () => {
    const filePath = path.join(os.tmpdir(), `sarif-empty-${Date.now()}.json`);
    tmpFiles.push(filePath);

    writeSarifOutput([], filePath);

    const log = JSON.parse(fs.readFileSync(filePath, 'utf-8'));

    expect(log.$schema).toContain('sarif-2.1.0');
    expect(log.version).toBe('2.1.0');
    expect(log.runs).toHaveLength(1);
    expect(log.runs[0].tool.driver.name).toBe('nark');
    expect(log.runs[0].results).toHaveLength(0);
    expect(log.runs[0].tool.driver.rules).toHaveLength(0);
  });

  it('two violations from same contract → one rule, two results', () => {
    const v1 = makeViolation({ id: 'v1', file: '/project/src/a.ts', line: 1 });
    const v2 = makeViolation({ id: 'v2', file: '/project/src/b.ts', line: 2 });

    const { filePath, log } = writeTmp([v1, v2]);
    tmpFiles.push(filePath);

    expect(log.runs[0].tool.driver.rules).toHaveLength(1);
    expect(log.runs[0].results).toHaveLength(2);
  });

  it('two violations from different contracts → two rules, two results', () => {
    const v1 = makeViolation({
      id: 'v1',
      package: 'axios',
      contract_clause: 'no-try-catch',
    });
    const v2 = makeViolation({
      id: 'v2',
      package: 'prisma',
      contract_clause: 'handle-not-found',
      function: 'prisma.user.findUnique',
      description: 'Missing NotFoundError handling',
      source_doc: 'https://prisma.io/docs/concepts/components/prisma-client/error-reference',
    });

    const { filePath, log } = writeTmp([v1, v2]);
    tmpFiles.push(filePath);

    expect(log.runs[0].tool.driver.rules).toHaveLength(2);
    expect(log.runs[0].results).toHaveLength(2);
  });

  it('severity mapping: error→error, warning→warning, info→note', () => {
    const vError = makeViolation({ id: 'e', severity: 'error' });
    const vWarning = makeViolation({
      id: 'w',
      severity: 'warning',
      contract_clause: 'warn-clause',
    });
    const vInfo = makeViolation({
      id: 'i',
      severity: 'info',
      contract_clause: 'info-clause',
    });

    const { filePath, log } = writeTmp([vError, vWarning, vInfo]);
    tmpFiles.push(filePath);

    const results = log.runs[0].results;
    expect(results.find((r: any) => r.ruleId === 'axios/no-try-catch').level).toBe('error');
    expect(results.find((r: any) => r.ruleId === 'axios/warn-clause').level).toBe('warning');
    expect(results.find((r: any) => r.ruleId === 'axios/info-clause').level).toBe('note');
  });

  it('ruleId format is "{package}/{contract_clause}"', () => {
    const v = makeViolation({ package: 'axios', contract_clause: 'no-try-catch' });
    const { filePath, log } = writeTmp([v]);
    tmpFiles.push(filePath);

    expect(log.runs[0].results[0].ruleId).toBe('axios/no-try-catch');
    expect(log.runs[0].tool.driver.rules[0].id).toBe('axios/no-try-catch');
  });

  it('location uri is relative (does not start with "/")', () => {
    const v = makeViolation({ file: '/project/src/foo.ts' });
    const { filePath, log } = writeTmp([v]);
    tmpFiles.push(filePath);

    const uri: string = log.runs[0].results[0].locations[0].physicalLocation.artifactLocation.uri;
    expect(uri.startsWith('/')).toBe(false);
    expect(uri.length).toBeGreaterThan(0);
  });

  it('outputPath writes to file; no outputPath writes to stdout', () => {
    // File output already covered by the other tests — verify content
    const filePath = path.join(os.tmpdir(), `sarif-stdout-test-${Date.now()}.json`);
    tmpFiles.push(filePath);

    const v = makeViolation();
    writeSarifOutput([v], filePath);

    const written = fs.readFileSync(filePath, 'utf-8');
    const log = JSON.parse(written);
    expect(log.version).toBe('2.1.0');

    // Stdout test — spy on process.stdout.write
    let captured = '';
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: any) => {
      captured += typeof chunk === 'string' ? chunk : chunk.toString();
      return true;
    });

    writeSarifOutput([v]);
    spy.mockRestore();

    const stdoutLog = JSON.parse(captured);
    expect(stdoutLog.version).toBe('2.1.0');
    expect(stdoutLog.runs[0].results).toHaveLength(1);
  });
});
