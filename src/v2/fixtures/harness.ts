/**
 * Ground-Truth Fixture Test Harness
 *
 * Provides helpers to:
 *   1. Run the V2 analyzer against a single ground-truth.ts file
 *   2. Parse SHOULD_FIRE / SHOULD_NOT_FIRE annotations in that file
 *   3. Match analyzer violations against annotations by line number
 *
 * Design goal: Tests are purely spec-driven. Annotations are written from
 * the contract spec, not from V1 output. Each annotation ties to a specific
 * postcondition ID from the contract YAML.
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { loadCorpus } from '../../corpus-loader.js';
import { UniversalAnalyzer } from '../analyzer.js';
import { ThrowingFunctionDetector } from '../plugins/throwing-function-detector.js';
import { PropertyChainDetector } from '../plugins/property-chain-detector.js';
import { EventListenerDetector } from '../plugins/event-listener-detector.js';
import { EventListenerAbsencePlugin } from '../plugins/event-listener-absence.js';
import { InstanceTrackerPlugin } from '../plugins/instance-tracker.js';
import type { PackageContract } from '../../types.js';
import type { Violation } from '../types/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// __dirname resolves to dist/v2/fixtures at runtime; corpus is at ../../../../nark-corpus
// relative to dist/v2/fixtures: ../../../ = verify-cli root, then ../nark-corpus
export const CORPUS_PATH = path.resolve(__dirname, '../../../../nark-corpus');

// ──────────────────────────────────────────────────────────────────────────────
// Annotation parsing
// ──────────────────────────────────────────────────────────────────────────────

export interface Annotation {
  /** 1-indexed line number of the call site (the line AFTER the annotation comment). */
  line: number;
  kind: 'SHOULD_FIRE' | 'SHOULD_NOT_FIRE';
  /** postcondition ID from the contract (only present for SHOULD_FIRE). */
  postconditionId?: string;
  /** Human-readable reason string from the annotation. */
  reason: string;
  /** Full annotation comment text for display in test names. */
  raw: string;
}

/**
 * Parse all SHOULD_FIRE / SHOULD_NOT_FIRE annotations from a source file.
 *
 * Annotation format (as single-line comments immediately above the call site):
 *   // SHOULD_FIRE: <postcondition-id> — <reason>
 *   // SHOULD_NOT_FIRE: <reason>
 *
 * The line number stored is the line after the annotation comment (the actual call site).
 */
export function parseAnnotations(filePath: string): Annotation[] {
  const source = fs.readFileSync(filePath, 'utf-8');
  const lines = source.split('\n');
  const annotations: Annotation[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    const shouldFireMatch = line.match(/^\/\/\s*SHOULD_FIRE:\s*(.+?)\s*[—–]\s*(.+)$/);
    if (shouldFireMatch) {
      const postconditionId = shouldFireMatch[1].trim();
      const reason = shouldFireMatch[2].trim();
      annotations.push({
        line: i + 2, // +1 for 0-index, +1 for "next line"
        kind: 'SHOULD_FIRE',
        postconditionId,
        reason,
        raw: line,
      });
      continue;
    }

    const shouldNotFireMatch = line.match(/^\/\/\s*SHOULD_NOT_FIRE:\s*(.+)$/);
    if (shouldNotFireMatch) {
      const reason = shouldNotFireMatch[1].trim();
      annotations.push({
        line: i + 2, // +1 for 0-index, +1 for "next line"
        kind: 'SHOULD_NOT_FIRE',
        reason,
        raw: line,
      });
    }
  }

  return annotations;
}

// ──────────────────────────────────────────────────────────────────────────────
// Analyzer runner
// ──────────────────────────────────────────────────────────────────────────────

export interface GroundTruthResult {
  violations: Violation[];
  /** Violations keyed by line number (1-indexed). */
  violationsByLine: Map<number, Violation[]>;
  /** All annotations parsed from the file. */
  annotations: Annotation[];
}

/**
 * Run the V2 analyzer against a single ground-truth.ts file.
 *
 * Uses a synthetic tsconfig that points only at the ground-truth file so tests
 * are isolated even though real package tsconfigs include more files.
 */
export async function runGroundTruth(
  groundTruthPath: string,
  corpusPath: string = CORPUS_PATH,
  options: { includeDrafts?: boolean } = {}
): Promise<GroundTruthResult> {
  // Load corpus
  const corpusResult = await loadCorpus(corpusPath, { includeDrafts: options.includeDrafts });
  if (corpusResult.errors.length > 0) {
    throw new Error(`Corpus load failed: ${corpusResult.errors.join(', ')}`);
  }
  const contracts: Map<string, PackageContract> = corpusResult.contracts;

  // Write a temporary tsconfig that includes only ground-truth.ts
  // We use the directory of the ground-truth file as the project root,
  // which ensures node_modules resolution works (the fixture dirs have package.json + node_modules).
  const fixtureDir = path.dirname(groundTruthPath);
  const tmpTsconfig = path.join(fixtureDir, '__ground-truth-tsconfig.json');

  const groundTruthFilename = path.basename(groundTruthPath);
  const tsConfigContent = {
    compilerOptions: {
      target: 'ES2020',
      module: 'commonjs',
      lib: ['ES2020'],
      strict: false, // relaxed so fixtures don't need perfect types
      esModuleInterop: true,
      skipLibCheck: true,
      moduleResolution: 'node',
    },
    include: [groundTruthFilename],
  };

  fs.writeFileSync(tmpTsconfig, JSON.stringify(tsConfigContent, null, 2));

  try {
    // Build detection maps from contracts
    const factoryToPackage = new Map<string, string>();
    const classToPackage = new Map<string, string>();
    const typeToPackage = new Map<string, string>();

    for (const [packageName, contract] of contracts.entries()) {
      const detection = contract.detection;
      if (!detection) continue;
      for (const cls of detection.class_names || []) classToPackage.set(cls, packageName);
      for (const factory of detection.factory_methods || []) factoryToPackage.set(factory, packageName);
      for (const typeName of detection.type_names || []) typeToPackage.set(typeName, packageName);
    }

    const instanceTracker = new InstanceTrackerPlugin(factoryToPackage, classToPackage, typeToPackage);

    const analyzer = new UniversalAnalyzer(
      { tsConfigPath: tmpTsconfig, corpusPath },
      contracts
    );

    analyzer.registerPlugin(instanceTracker);
    analyzer.registerPlugin(new ThrowingFunctionDetector(instanceTracker));
    analyzer.registerPlugin(new PropertyChainDetector(instanceTracker));
    analyzer.registerPlugin(new EventListenerDetector());
    analyzer.registerPlugin(new EventListenerAbsencePlugin(contracts));

    analyzer.initialize();
    const result = analyzer.analyze();

    // Collect violations only from ground-truth.ts
    const violations: Violation[] = [];
    for (const fileResult of result.files) {
      if (fileResult.file.includes(groundTruthFilename)) {
        violations.push(...fileResult.violations.filter(v => !v.suppressed));
      }
    }

    // Build line → violations map
    const violationsByLine = new Map<number, Violation[]>();
    for (const v of violations) {
      if (!violationsByLine.has(v.line)) violationsByLine.set(v.line, []);
      violationsByLine.get(v.line)!.push(v);
    }

    const annotations = parseAnnotations(groundTruthPath);

    return { violations, violationsByLine, annotations };
  } finally {
    // Clean up temp tsconfig
    try { fs.unlinkSync(tmpTsconfig); } catch { /* ignore */ }
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Assertion helpers (used in test files)
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Assert that there is at least one violation on the given line,
 * and optionally that it matches the expected postconditionId.
 */
export function assertFires(
  violationsByLine: Map<number, Violation[]>,
  annotation: Annotation
): { passed: boolean; message: string } {
  const viols = violationsByLine.get(annotation.line) ?? [];

  if (viols.length === 0) {
    return {
      passed: false,
      message: `Expected violation at line ${annotation.line} (${annotation.postconditionId}) but got none.\n  Reason: ${annotation.reason}`,
    };
  }

  // If postconditionId specified, check it matches one of the violations
  if (annotation.postconditionId) {
    const matchesPostcondition = viols.some(
      v => v.postconditionId === annotation.postconditionId
    );
    if (!matchesPostcondition) {
      const actualIds = viols.map(v => v.postconditionId).join(', ');
      return {
        passed: false,
        message: [
          `Line ${annotation.line}: expected postconditionId '${annotation.postconditionId}' but got [${actualIds}].`,
          `  Reason: ${annotation.reason}`,
          `  Violations: ${viols.map(v => `${v.package}:${v.function}:${v.postconditionId}`).join(' | ')}`,
        ].join('\n'),
      };
    }
  }

  return { passed: true, message: '' };
}

/**
 * Assert that there are NO error-level violations on the given line.
 *
 * Warnings (e.g. for incomplete catch blocks — missing 429 handling, no
 * error.response check) are informational and do not count as violations
 * of the "must try-catch" contract requirement. SHOULD_NOT_FIRE tests
 * only check that the primary try-catch requirement is satisfied.
 */
export function assertNotFires(
  violationsByLine: Map<number, Violation[]>,
  annotation: Annotation
): { passed: boolean; message: string } {
  const allViols = violationsByLine.get(annotation.line) ?? [];
  // Only count error-level violations (warnings are advisory)
  const errorViols = allViols.filter(v => v.severity === 'error');

  if (errorViols.length > 0) {
    return {
      passed: false,
      message: [
        `Line ${annotation.line}: expected no error-level violation but got ${errorViols.length}.`,
        `  Reason: ${annotation.reason}`,
        `  Error violations: ${errorViols.map(v => `${v.package}:${v.function}:${v.postconditionId} (${v.severity})`).join(' | ')}`,
      ].join('\n'),
    };
  }

  return { passed: true, message: '' };
}
