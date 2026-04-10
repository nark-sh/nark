/**
 * Fixture Testing Utilities
 *
 * Validates actual analyzer violations against expected fixture outputs.
 */

import type {
  ExpectedViolations,
  ViolationExpectation,
  FixtureTestResult,
  ViolationDiscrepancy
} from '../../corpus/types/index.js';
import type { Violation } from './types.js';

/**
 * Validates actual violations against expected patterns
 *
 * @param actual - Violations found by the analyzer
 * @param expected - Expected violation patterns
 * @returns Test result with pass/fail and discrepancies
 */
export function validateFixtureViolations(
  actual: Violation[],
  expected: ExpectedViolations
): FixtureTestResult {
  const discrepancies: ViolationDiscrepancy[] = [];

  // Check summary counts
  validateSummaryCounts(actual, expected, discrepancies);

  // Check each individual expectation
  for (const expectation of expected.expectations) {
    if (expectation.pending) {
      continue; // Skip pending expectations
    }

    validateExpectation(actual, expectation, discrepancies);
  }

  return {
    fixtureFile: expected.fixtures,
    passed: discrepancies.length === 0,
    actualViolations: actual.length,
    expectedViolations: expected.expectations.length,
    discrepancies
  };
}

/**
 * Validates that violation counts match expected ranges
 */
function validateSummaryCounts(
  actual: Violation[],
  expected: ExpectedViolations,
  discrepancies: ViolationDiscrepancy[]
): void {
  const errorCount = actual.filter(v => v.severity === 'error').length;
  const warningCount = actual.filter(v => v.severity === 'warning').length;
  const infoCount = actual.filter(v => v.severity === 'info').length;

  const { expectedErrorCount, expectedWarningCount, expectedInfoCount } = expected.summary;

  // Check error count
  if (errorCount < expectedErrorCount.min || errorCount > expectedErrorCount.max) {
    discrepancies.push({
      type: 'count-mismatch',
      message: `Error count: expected ${expectedErrorCount.min}-${expectedErrorCount.max}, got ${errorCount}`
    });
  }

  // Check warning count
  if (warningCount < expectedWarningCount.min || warningCount > expectedWarningCount.max) {
    discrepancies.push({
      type: 'count-mismatch',
      message: `Warning count: expected ${expectedWarningCount.min}-${expectedWarningCount.max}, got ${warningCount}`
    });
  }

  // Check info count
  if (infoCount < expectedInfoCount.min || infoCount > expectedInfoCount.max) {
    discrepancies.push({
      type: 'count-mismatch',
      message: `Info count: expected ${expectedInfoCount.min}-${expectedInfoCount.max}, got ${infoCount}`
    });
  }
}

/**
 * Validates a single expectation against actual violations
 */
function validateExpectation(
  actual: Violation[],
  expectation: ViolationExpectation,
  discrepancies: ViolationDiscrepancy[]
): void {
  // Find matching violations
  const matchingViolations = actual.filter(v =>
    matchesExpectation(v, expectation)
  );

  const maxViolations = expectation.maxViolations ?? expectation.minViolations;

  // Check if we have too few violations
  if (matchingViolations.length < expectation.minViolations) {
    discrepancies.push({
      type: 'missing',
      expectation,
      message: `${expectation.id}: Expected at least ${expectation.minViolations} violations, found ${matchingViolations.length}${
        expectation.description ? ` (${expectation.description})` : ''
      }`
    });
  }

  // Check if we have too many violations
  if (matchingViolations.length > maxViolations) {
    discrepancies.push({
      type: 'unexpected',
      expectation,
      message: `${expectation.id}: Expected at most ${maxViolations} violations, found ${matchingViolations.length}${
        expectation.description ? ` (${expectation.description})` : ''
      }`
    });
  }

  // Check line numbers (if specified)
  if (expectation.approximateLines && matchingViolations.length > 0) {
    const [minLine, maxLine] = expectation.approximateLines;
    const tolerance = 5; // ±5 lines

    const outOfRange = matchingViolations.filter(v =>
      v.line < minLine - tolerance || v.line > maxLine + tolerance
    );

    if (outOfRange.length > 0) {
      for (const v of outOfRange) {
        discrepancies.push({
          type: 'wrong-line',
          expectation,
          actualViolation: v,
          message: `${expectation.id}: Violation at line ${v.line} outside expected range [${minLine}, ${maxLine}] (±${tolerance})`
        });
      }
    }
  }

  // Check severity (if violations found)
  if (matchingViolations.length > 0) {
    const wrongSeverity = matchingViolations.filter(v =>
      v.severity !== expectation.severity
    );

    if (wrongSeverity.length > 0) {
      for (const v of wrongSeverity) {
        discrepancies.push({
          type: 'wrong-severity',
          expectation,
          actualViolation: v,
          message: `${expectation.id}: Expected severity '${expectation.severity}', got '${v.severity}' at line ${v.line}`
        });
      }
    }
  }
}

/**
 * Checks if a violation matches an expectation
 */
function matchesExpectation(
  violation: Violation,
  expectation: ViolationExpectation
): boolean {
  // Check function name (if specified)
  if (expectation.functionName && violation.function !== expectation.functionName) {
    return false;
  }

  // Check if contract clause is in expected list
  if (!expectation.expectedClauses.includes(violation.contract_clause)) {
    return false;
  }

  // Check severity (if specified)
  if (expectation.severity && violation.severity !== expectation.severity) {
    return false;
  }

  return true;
}

/**
 * Formats discrepancies for human-readable output
 */
export function formatDiscrepancies(result: FixtureTestResult): string {
  if (result.discrepancies.length === 0) {
    return '  No discrepancies - all expectations met! ✅';
  }

  const lines = result.discrepancies.map((d, index) => {
    const prefix = `  ${index + 1}. [${d.type}]`;
    return `${prefix} ${d.message}`;
  });

  return lines.join('\n');
}

/**
 * Groups violations by function name for easier analysis
 */
export function groupViolationsByFunction(violations: Violation[]): Map<string, Violation[]> {
  const groups = new Map<string, Violation[]>();

  for (const v of violations) {
    const functionName = v.function || 'unknown';
    if (!groups.has(functionName)) {
      groups.set(functionName, []);
    }
    groups.get(functionName)!.push(v);
  }

  return groups;
}

/**
 * Helper for analyzing violation patterns (useful for creating expectations)
 */
export function analyzeViolationPatterns(violations: Violation[]): void {
  console.log('\n=== Violation Analysis ===');
  console.log(`Total violations: ${violations.length}\n`);

  const byFunction = groupViolationsByFunction(violations);

  for (const [functionName, viols] of byFunction.entries()) {
    console.log(`Function: ${functionName}`);
    console.log(`  Violations: ${viols.length}`);

    const clauses = [...new Set(viols.map(v => v.contract_clause))];
    console.log(`  Clauses: ${clauses.join(', ')}`);

    const severities = [...new Set(viols.map(v => v.severity))];
    console.log(`  Severities: ${severities.join(', ')}`);

    const lines = viols.map(v => v.line);
    console.log(`  Line range: ${Math.min(...lines)}-${Math.max(...lines)}`);
    console.log('');
  }
}
