/**
 * V2 Adapter
 *
 * Bridges the v2 plugin-based analyzer output to the v1 Violation[] format
 * expected by the CLI in src/index.ts.
 *
 * This allows the v2 analyzer to be used as a drop-in replacement for v1
 * while we transition, or run side-by-side for comparison.
 */

import type { PackageContract } from '../types.js';
import type { Violation as V1Violation, AnalyzerConfig as V1Config } from '../types.js';
import type { Violation as V2Violation } from './types/index.js';
import { UniversalAnalyzer } from './analyzer.js';
import { ThrowingFunctionDetector } from './plugins/throwing-function-detector.js';
import { PropertyChainDetector } from './plugins/property-chain-detector.js';
import { EventListenerDetector } from './plugins/event-listener-detector.js';
import { EventListenerAbsencePlugin } from './plugins/event-listener-absence.js';
import { ReturnValueChecker } from './plugins/return-value-checker.js';
import { InstanceTrackerPlugin } from './plugins/instance-tracker.js';

export interface V2AdapterResult {
  violations: V1Violation[];
  suppressedViolations: V1Violation[];
  filesAnalyzed: number;
  detectionCount: number;
  fileDurations: { file: string; durationMs: number }[];   // all analyzed files with timing
  skippedFiles: { reason: string; count: number }[];        // skip reasons with counts
  callSitesByPackage: Record<string, number>;               // real per-package call site counts (pass + fail)
}

/**
 * Run the v2 plugin-based analyzer and return results in v1 format.
 *
 * @param config - V1 analyzer config (tsconfigPath, corpusPath, etc.)
 * @param contracts - Loaded package contracts
 * @returns Violations in v1 format plus suppressed violations
 */
import type { ProgressCallback } from './analyzer.js';

export async function runV2Analyzer(
  config: V1Config,
  contracts: Map<string, PackageContract>,
  onProgress?: ProgressCallback
): Promise<V2AdapterResult> {
  // Build detection maps from contracts (factory methods, class names, type names)
  const factoryToPackage = new Map<string, string>();
  const classToPackage = new Map<string, string>();
  const typeToPackage = new Map<string, string>();

  for (const [packageName, contract] of contracts.entries()) {
    const detection = contract.detection;
    if (!detection) continue;

    for (const cls of detection.class_names || []) {
      classToPackage.set(cls, packageName);
    }
    for (const factory of detection.factory_methods || []) {
      factoryToPackage.set(factory, packageName);
    }
    for (const typeName of detection.type_names || []) {
      typeToPackage.set(typeName, packageName);
    }
  }

  // Create shared instance tracker (consulted by other plugins)
  const instanceTracker = new InstanceTrackerPlugin(factoryToPackage, classToPackage, typeToPackage);

  // Create v2 analyzer config
  const v2Config = {
    tsConfigPath: config.tsconfigPath,
    corpusPath: config.corpusPath,
    includePaths: config.includePaths,
    excludePaths: config.excludePaths,
    includeTests: config.includeTests,
  };

  // Create analyzer with contracts for contract matching
  const analyzer = new UniversalAnalyzer(v2Config, contracts);

  // Register plugins in order (InstanceTracker must come before plugins that use it)
  analyzer.registerPlugin(instanceTracker);
  analyzer.registerPlugin(new ThrowingFunctionDetector(instanceTracker));
  analyzer.registerPlugin(new PropertyChainDetector(instanceTracker));
  analyzer.registerPlugin(new EventListenerDetector());
  analyzer.registerPlugin(new EventListenerAbsencePlugin(contracts));
  analyzer.registerPlugin(new ReturnValueChecker());

  // Initialize and run
  if (onProgress) {
    analyzer.onProgress = onProgress;
  }
  analyzer.initialize();
  const result = analyzer.analyze();

  // Convert v2 violations to v1 format, split by suppressed status
  const activeViolations: V1Violation[] = [];
  const suppressedViolations: V1Violation[] = [];
  let totalDetections = 0;

  // Collect per-file timing diagnostics
  const fileDurations: { file: string; durationMs: number }[] = [];

  for (const fileResult of result.files) {
    totalDetections += fileResult.detections.length;
    fileDurations.push({ file: fileResult.file, durationMs: fileResult.duration });

    for (const v2Viol of fileResult.violations) {
      const v1Viol = convertViolation(v2Viol, contracts);

      if (v2Viol.suppressed) {
        suppressedViolations.push(v1Viol);
      } else {
        activeViolations.push(v1Viol);
      }
    }
  }

  // Approximate skipped file count: total program source files minus files analyzed
  // (declaration files, node_modules, test files filtered by UniversalAnalyzer.analyze())
  const skippedFiles: { reason: string; count: number }[] = [];
  const skippedCount = analyzer.getTotalSourceFileCount() - result.filesAnalyzed;
  if (skippedCount > 0) {
    skippedFiles.push({ reason: 'declaration/test/node_modules files', count: skippedCount });
  }

  return {
    violations: activeViolations,
    suppressedViolations,
    filesAnalyzed: result.filesAnalyzed,
    detectionCount: totalDetections,
    fileDurations,
    skippedFiles,
    callSitesByPackage: analyzer.getCallSitesByPackage(),
  };
}

/**
 * Convert a v2 Violation to v1 Violation format.
 *
 * The v2 violation has the info needed; we just need to look up
 * source_doc and suggested_fix from the contract.
 */
function convertViolation(
  v2: V2Violation,
  contracts: Map<string, PackageContract>
): V1Violation {
  // Look up source doc and suggested fix from contract
  const contract = contracts.get(v2.package);
  let sourceDoc = '';
  let suggestedFix: string | undefined;

  if (contract) {
    const funcContract = contract.functions.find((f) => f.name === v2.function);
    if (funcContract) {
      const postcondition = (funcContract.postconditions || []).find(
        (p) => p.id === v2.postconditionId
      );
      if (postcondition) {
        sourceDoc = postcondition.sources?.[0] || postcondition.source || '';
        suggestedFix = postcondition.required_handling;
      }
    }
  }

  // Build stable ID from location
  const id = `${v2.package}:${v2.function}:${v2.postconditionId}:${v2.line}:${v2.column}`;

  return {
    id,
    severity: v2.severity,
    file: v2.file,
    line: v2.line,
    column: v2.column,
    package: v2.package,
    function: v2.function,
    contract_clause: v2.postconditionId,
    description: v2.message,
    source_doc: sourceDoc,
    suggested_fix: suggestedFix,
    subViolations: v2.subViolations?.map((sv) => ({
      postconditionId: sv.postconditionId,
      description: sv.message,
      severity: sv.severity,
    })),
    // code_snippet not populated (would need async file read)
  };
}
