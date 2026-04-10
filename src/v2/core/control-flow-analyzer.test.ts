/**
 * Tests for ControlFlowAnalysis
 *
 * Tests isInTryCatch, catchChecksStatusCode, catchChecksResponseExists,
 * extractHandledStatusCodes, and catchHasRetryLogic.
 */

import { describe, it, expect } from 'vitest';
import * as ts from 'typescript';
import { ControlFlowAnalysis } from './control-flow-analyzer.js';

// ────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────

/** Parse TypeScript source with parent pointers set. */
function parse(source: string): ts.SourceFile {
  return ts.createSourceFile('test.ts', source, ts.ScriptTarget.ES2020, true);
}

/** Walk the AST and return the first node matching predicate. */
function findFirst<T extends ts.Node>(
  root: ts.Node,
  predicate: (n: ts.Node) => n is T
): T | undefined {
  let found: T | undefined;
  function visit(n: ts.Node): void {
    if (found) return;
    if (predicate(n)) { found = n; return; }
    ts.forEachChild(n, visit);
  }
  visit(root);
  return found;
}

/** Walk the AST and return all nodes matching predicate. */
function findAll<T extends ts.Node>(
  root: ts.Node,
  predicate: (n: ts.Node) => n is T
): T[] {
  const results: T[] = [];
  function visit(n: ts.Node): void {
    if (predicate(n)) results.push(n);
    ts.forEachChild(n, visit);
  }
  visit(root);
  return results;
}

// ────────────────────────────────────────────────────────
// isInTryCatch tests
// ────────────────────────────────────────────────────────

describe('ControlFlowAnalysis.isInTryCatch', () => {
  const cfa = new ControlFlowAnalysis();

  it('returns true for a call inside a try block', () => {
    const sf = parse(`
      try {
        await axios.get('/api');
      } catch (e) {}
    `);
    const call = findFirst(sf, ts.isCallExpression)!;
    expect(call).toBeDefined();
    expect(cfa.isInTryCatch(call)).toBe(true);
  });

  it('returns false for a call outside any try block', () => {
    const sf = parse(`
      await axios.get('/api');
    `);
    const call = findFirst(sf, ts.isCallExpression)!;
    expect(call).toBeDefined();
    expect(cfa.isInTryCatch(call)).toBe(false);
  });

  it('returns false for a call inside a catch block', () => {
    const sf = parse(`
      try {
        doSomething();
      } catch (e) {
        await axios.get('/retry');
      }
    `);
    const calls = findAll(sf, ts.isCallExpression);
    // Find the axios.get call (it's in the catch block, not the try block)
    const axiosCall = calls.find(c =>
      ts.isPropertyAccessExpression(c.expression) &&
      ts.isIdentifier(c.expression.expression) &&
      c.expression.expression.text === 'axios'
    );
    expect(axiosCall).toBeDefined();
    expect(cfa.isInTryCatch(axiosCall!)).toBe(false);
  });

  it('returns true for nested try blocks', () => {
    const sf = parse(`
      try {
        try {
          await axios.get('/api');
        } catch (inner) {}
      } catch (outer) {}
    `);
    const calls = findAll(sf, ts.isCallExpression);
    const axiosCall = calls.find(c =>
      ts.isPropertyAccessExpression(c.expression)
    );
    expect(axiosCall).toBeDefined();
    expect(cfa.isInTryCatch(axiosCall!)).toBe(true);
  });

  it('returns false for try without catch (only finally)', () => {
    const sf = parse(`
      try {
        await axios.get('/api');
      } finally {
        cleanup();
      }
    `);
    const call = findFirst(sf, ts.isCallExpression)!;
    expect(cfa.isInTryCatch(call)).toBe(false);
  });
});

// ────────────────────────────────────────────────────────
// catchChecksStatusCode tests
// ────────────────────────────────────────────────────────

describe('ControlFlowAnalysis.catchChecksStatusCode', () => {
  const cfa = new ControlFlowAnalysis();

  function getCatchClause(source: string): ts.CatchClause {
    const sf = parse(source);
    const clause = findFirst(sf, ts.isCatchClause);
    if (!clause) throw new Error('No catch clause found');
    return clause;
  }

  it('returns true when catch checks error.response.status', () => {
    const clause = getCatchClause(`
      try { await axios.get('/api'); } catch (e) {
        if (e.response.status === 500) { throw e; }
      }
    `);
    expect(cfa.catchChecksStatusCode(clause)).toBe(true);
  });

  it('returns false when catch does not check status', () => {
    const clause = getCatchClause(`
      try { await axios.get('/api'); } catch (e) {
        console.error(e.message);
      }
    `);
    expect(cfa.catchChecksStatusCode(clause)).toBe(false);
  });
});

// ────────────────────────────────────────────────────────
// catchChecksResponseExists tests
// ────────────────────────────────────────────────────────

describe('ControlFlowAnalysis.catchChecksResponseExists', () => {
  const cfa = new ControlFlowAnalysis();

  function getCatchClause(source: string): ts.CatchClause {
    const sf = parse(source);
    const clause = findFirst(sf, ts.isCatchClause);
    if (!clause) throw new Error('No catch clause found');
    return clause;
  }

  it('returns true when catch checks if (error.response)', () => {
    const clause = getCatchClause(`
      try { await axios.get('/api'); } catch (error) {
        if (error.response) { console.log(error.response.status); }
      }
    `);
    expect(cfa.catchChecksResponseExists(clause)).toBe(true);
  });

  it('returns true when catch uses optional chaining error.response?.status', () => {
    const clause = getCatchClause(`
      try { await axios.get('/api'); } catch (error) {
        const status = error.response?.status;
      }
    `);
    expect(cfa.catchChecksResponseExists(clause)).toBe(true);
  });

  it('returns false when catch has no response check', () => {
    const clause = getCatchClause(`
      try { await axios.get('/api'); } catch (error) {
        console.error(error.message);
        throw error;
      }
    `);
    expect(cfa.catchChecksResponseExists(clause)).toBe(false);
  });
});

// ────────────────────────────────────────────────────────
// extractHandledStatusCodes tests
// ────────────────────────────────────────────────────────

describe('ControlFlowAnalysis.extractHandledStatusCodes', () => {
  const cfa = new ControlFlowAnalysis();

  function getCatchClause(source: string): ts.CatchClause {
    const sf = parse(source);
    const clause = findFirst(sf, ts.isCatchClause);
    if (!clause) throw new Error('No catch clause found');
    return clause;
  }

  it('extracts 429 from status code comparison', () => {
    const clause = getCatchClause(`
      try { await axios.get('/'); } catch (e) {
        if (e.response.status === 429) { retry(); }
      }
    `);
    const codes = cfa.extractHandledStatusCodes(clause);
    expect(codes).toContain(429);
  });

  it('extracts multiple status codes', () => {
    const clause = getCatchClause(`
      try { await axios.get('/'); } catch (e) {
        if (e.response.status === 404) throw e;
        if (e.response.status === 429) retry();
        if (e.response.status === 500) alert();
      }
    `);
    const codes = cfa.extractHandledStatusCodes(clause);
    expect(codes).toContain(404);
    expect(codes).toContain(429);
    expect(codes).toContain(500);
  });

  it('returns empty array when no status codes handled', () => {
    const clause = getCatchClause(`
      try { await axios.get('/'); } catch (e) {
        console.error(e);
      }
    `);
    const codes = cfa.extractHandledStatusCodes(clause);
    expect(codes).toHaveLength(0);
  });
});

// ────────────────────────────────────────────────────────
// catchHasRetryLogic tests
// ────────────────────────────────────────────────────────

describe('ControlFlowAnalysis.catchHasRetryLogic', () => {
  const cfa = new ControlFlowAnalysis();

  function getCatchClause(source: string): ts.CatchClause {
    const sf = parse(source);
    const clause = findFirst(sf, ts.isCatchClause);
    if (!clause) throw new Error('No catch clause found');
    return clause;
  }

  it('detects "retry" keyword', () => {
    const clause = getCatchClause(`
      try { await axios.get('/'); } catch (e) {
        if (retryCount < 3) { await retry(fn); }
      }
    `);
    expect(cfa.catchHasRetryLogic(clause)).toBe(true);
  });

  it('detects "backoff" keyword', () => {
    const clause = getCatchClause(`
      try { await axios.get('/'); } catch (e) {
        await exponentialBackoff(attempt);
      }
    `);
    expect(cfa.catchHasRetryLogic(clause)).toBe(true);
  });

  it('returns false when no retry logic', () => {
    const clause = getCatchClause(`
      try { await axios.get('/'); } catch (e) {
        console.error('Request failed', e);
        throw e;
      }
    `);
    expect(cfa.catchHasRetryLogic(clause)).toBe(false);
  });
});
