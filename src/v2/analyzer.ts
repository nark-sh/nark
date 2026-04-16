/**
 * Universal Analyzer v2
 *
 * Main entry point for the universal analyzer.
 * Orchestrates AST traversal, plugin execution, and contract matching.
 */

import * as ts from 'typescript';
import * as path from 'path';
import * as fs from 'fs';
import {
  AnalyzerConfig,
  ProjectAnalysisResult,
  FileAnalysisResult,
  Violation,
  AnalysisError,
  DetectorPlugin,
} from './types/index.js';
import { TraversalEngine } from './core/traversal-engine.js';
import { ContractMatcher } from './core/contract-matcher.js';
import type { PackageContract } from '../types.js';

/**
 * Universal Analyzer v2
 *
 * Plugin-based analyzer that can detect any pattern without modification.
 */
export type ProgressCallback = (current: number, total: number, fileName: string) => void;

export class UniversalAnalyzer {
  private config: AnalyzerConfig;
  private program!: ts.Program;
  private plugins: DetectorPlugin[] = [];
  private contracts: Map<string, PackageContract>;
  private contractMatcher?: ContractMatcher;
  public onProgress?: ProgressCallback;

  constructor(config: AnalyzerConfig, contracts?: Map<string, PackageContract>) {
    this.config = config;
    this.contracts = contracts || new Map();
  }

  /**
   * Register a detector plugin
   */
  public registerPlugin(plugin: DetectorPlugin): void {
    this.plugins.push(plugin);
  }

  /**
   * Initialize analyzer
   *
   * Loads TypeScript program and prepares for analysis.
   */
  public initialize(): void {
    // Load tsconfig.json
    const configPath = path.resolve(this.config.tsConfigPath);
    if (!fs.existsSync(configPath)) {
      throw new Error(`tsconfig.json not found at: ${configPath}`);
    }

    // Parse tsconfig.json
    const configFile = ts.readConfigFile(configPath, ts.sys.readFile);
    if (configFile.error) {
      throw new Error(`Error reading tsconfig.json: ${configFile.error.messageText}`);
    }

    const parsedConfig = ts.parseJsonConfigFileContent(
      configFile.config,
      ts.sys,
      path.dirname(configPath)
    );

    if (parsedConfig.errors.length > 0) {
      const errors = parsedConfig.errors.map((e) => typeof e.messageText === 'string' ? e.messageText : String(e.messageText)).join('\n');

      // Detect "no inputs found" — means no TypeScript files matched the include patterns
      if (errors.includes('No inputs were found')) {
        throw new Error(
          'NO_TS_FILES: No TypeScript files found to analyze.\n' +
          '\n' +
          '  This usually means you ran `npx nark` in a directory that isn\'t a\n' +
          '  TypeScript project, or the project\'s TypeScript files are in a\n' +
          '  subdirectory that wasn\'t included.\n' +
          '\n' +
          '  To fix this:\n' +
          '    1. cd into your TypeScript project first:\n' +
          '       cd my-project && npx nark\n' +
          '\n' +
          '    2. Or point nark at your tsconfig directly:\n' +
          '       npx nark --tsconfig path/to/my-project/tsconfig.json\n'
        );
      }

      throw new Error(`Error parsing tsconfig.json: ${errors}`);
    }

    // Create TypeScript program
    try {
      this.program = ts.createProgram({
        rootNames: parsedConfig.fileNames,
        options: parsedConfig.options,
      });
    } catch (error: unknown) {
      throw new Error(`Failed to create TypeScript program: ${error instanceof Error ? error.message : String(error)}`);
    }

    const fileNotFoundDiagnostics = ts.getPreEmitDiagnostics(this.program)
      .filter(d => d.code === 6053);
    if (fileNotFoundDiagnostics.length > 0) {
      const messages = fileNotFoundDiagnostics
        .map(d => ts.flattenDiagnosticMessageText(d.messageText, '\n'))
        .join('\n');
      throw new Error(`TypeScript file-not-found errors:\n${messages}`);
    }

    // Create contract matcher if contracts are provided
    if (this.contracts.size > 0) {
      this.contractMatcher = new ContractMatcher(this.contracts, {
        projectRoot: path.dirname(path.resolve(this.config.tsConfigPath)),
        analyzerVersion: '2.0.0',
        program: this.program,
      });
    }
  }

  /**
   * Returns the total number of source files in the TypeScript program,
   * including those filtered out during analysis (for skipped file count diagnostics).
   */
  public getTotalSourceFileCount(): number {
    if (!this.program) return 0;
    return this.program.getSourceFiles().length;
  }

  /**
   * Returns real per-package call site counts from the contract matcher.
   * Includes both passing and failing evaluations — honest "N call sites evaluated" numbers.
   */
  public getCallSitesByPackage(): Record<string, number> {
    if (!this.contractMatcher) return {};
    return this.contractMatcher.callSitesByPackage;
  }

  /**
   * Analyze all source files in the project
   */
  public analyze(): ProjectAnalysisResult {
    if (!this.program) {
      throw new Error('Analyzer not initialized. Call initialize() first.');
    }

    const startTime = Date.now();
    const fileResults: FileAnalysisResult[] = [];
    let totalDetections = 0;
    let totalViolations = 0;

    // Get all source files
    const sourceFiles = this.program.getSourceFiles().filter((sf) => {
      // Skip declaration files
      if (sf.isDeclarationFile) {
        return false;
      }

      // Skip node_modules
      if (sf.fileName.includes('node_modules')) {
        return false;
      }

      // Skip test files unless explicitly included
      if (!this.config.includeTests && this.isTestFile(sf.fileName)) {
        return false;
      }

      // Apply include/exclude paths if specified
      if (this.config.includePaths) {
        return this.config.includePaths.some((p: string) => sf.fileName.includes(p));
      }

      if (this.config.excludePaths) {
        return !this.config.excludePaths.some((p: string) => sf.fileName.includes(p));
      }

      return true;
    });

    // Build detection maps for cross-module re-export resolution
    const factoryToPackage = new Map<string, string>();
    const classToPackage = new Map<string, string>();
    for (const [packageName, contract] of this.contracts.entries()) {
      const detection = contract.detection;
      if (!detection) continue;
      for (const cls of detection.class_names || []) classToPackage.set(cls, packageName);
      for (const factory of detection.factory_methods || []) factoryToPackage.set(factory, packageName);
    }

    // Scan all project files for re-exported package instances (e.g., export const sql = neon(...))
    const reExportMap = this.buildReExportMap(sourceFiles, factoryToPackage, classToPackage);

    // Create traversal engine with known packages for subpath import normalization
    const knownPackages = this.contracts.size > 0 ? new Set(this.contracts.keys()) : undefined;
    const engine = new TraversalEngine(this.program, knownPackages, reExportMap);

    // Register plugins with engine
    for (const plugin of this.plugins) {
      engine.registerPlugin(plugin);
    }

    // Analyze each file
    for (let i = 0; i < sourceFiles.length; i++) {
      const sourceFile = sourceFiles[i];
      if (this.onProgress) {
        this.onProgress(i + 1, sourceFiles.length, sourceFile.fileName);
      }
      const result = this.analyzeFile(sourceFile, engine);
      fileResults.push(result);
      totalDetections += result.detections.length;
      totalViolations += result.violations.length;
    }

    const duration = Date.now() - startTime;

    return {
      projectPath: path.dirname(this.config.tsConfigPath),
      filesAnalyzed: fileResults.length,
      totalDetections,
      totalViolations,
      files: fileResults,
      statistics: this.calculateStatistics(fileResults),
      duration,
    };
  }

  /**
   * Analyze a single source file
   */
  private analyzeFile(sourceFile: ts.SourceFile, engine: TraversalEngine): FileAnalysisResult {
    const startTime = Date.now();
    const errors: AnalysisError[] = [];

    try {
      // Run traversal to get detections
      const detections = engine.analyze(sourceFile);

      // Match detections to contracts to get violations
      let violations: Violation[] = [];
      if (this.contractMatcher) {
        violations = this.contractMatcher.matchDetections(detections, sourceFile);
      }

      const duration = Date.now() - startTime;

      return {
        file: sourceFile.fileName,
        detections,
        violations,
        duration,
        errors,
      };
    } catch (error) {
      errors.push({
        message: error instanceof Error ? error.message : String(error),
        file: sourceFile.fileName,
        stack: error instanceof Error ? error.stack : undefined,
      });

      return {
        file: sourceFile.fileName,
        detections: [],
        violations: [],
        duration: Date.now() - startTime,
        errors,
      };
    }
  }

  /**
   * Calculate aggregate statistics
   */
  private calculateStatistics(fileResults: FileAnalysisResult[]) {
    const byPackage = new Map<string, number>();
    const bySeverity = new Map<'error' | 'warning', number>();
    const byFile = new Map<string, number>();
    const byPlugin = new Map<string, number>();

    for (const result of fileResults) {
      // Count violations by file
      byFile.set(result.file, result.violations.length);

      // Count violations by package and severity
      for (const violation of result.violations) {
        byPackage.set(violation.package, (byPackage.get(violation.package) || 0) + 1);
        bySeverity.set(violation.severity, (bySeverity.get(violation.severity) || 0) + 1);
      }

      // Count detections by plugin
      for (const detection of result.detections) {
        byPlugin.set(detection.pluginName, (byPlugin.get(detection.pluginName) || 0) + 1);
      }
    }

    return {
      byPackage,
      bySeverity,
      byFile,
      byPlugin,
    };
  }

  /**
   * Build a cross-module re-export map by scanning all project source files.
   *
   * Returns: Map<absoluteFilePath, Map<exportedName, packageName>>
   */
  private buildReExportMap(
    sourceFiles: readonly ts.SourceFile[],
    factoryToPackage: Map<string, string>,
    classToPackage: Map<string, string>
  ): Map<string, Map<string, string>> {
    const reExportMap = new Map<string, Map<string, string>>();

    for (const sf of sourceFiles) {
      if (sf.isDeclarationFile || sf.fileName.includes('node_modules')) continue;

      // Collect local imports for this file
      const localImports = new Map<string, string>(); // localName → packageName
      ts.forEachChild(sf, (node) => {
        if (!ts.isImportDeclaration(node)) return;
        if (!ts.isStringLiteral(node.moduleSpecifier)) return;
        const pkg = node.moduleSpecifier.text;
        const clause = node.importClause;
        if (!clause) return;
        if (clause.name) localImports.set(clause.name.text, pkg);
        if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
          for (const el of clause.namedBindings.elements) {
            localImports.set(el.name.text, pkg);
          }
        }
      });

      // Find exported variable declarations whose initializers create package instances
      const fileExports = new Map<string, string>();
      ts.forEachChild(sf, (node) => {
        if (!ts.isVariableStatement(node)) return;
        const isExported = node.modifiers?.some(
          (m) => m.kind === ts.SyntaxKind.ExportKeyword
        ) ?? false;
        if (!isExported) return;
        for (const decl of node.declarationList.declarations) {
          if (!ts.isIdentifier(decl.name) || !decl.initializer) continue;
          const pkg = this.resolveInitializerToPackage(
            decl.initializer, localImports, factoryToPackage, classToPackage
          );
          if (pkg) fileExports.set(decl.name.text, pkg);
        }
      });

      if (fileExports.size > 0) {
        reExportMap.set(sf.fileName, fileExports);
      }
    }

    return reExportMap;
  }

  /**
   * Determine which contracted package an initializer expression creates an instance of.
   */
  private resolveInitializerToPackage(
    init: ts.Expression,
    localImports: Map<string, string>,
    factoryToPackage: Map<string, string>,
    classToPackage: Map<string, string>
  ): string | null {
    if (ts.isNewExpression(init) && ts.isIdentifier(init.expression)) {
      const name = init.expression.text;
      return localImports.get(name) ?? classToPackage.get(name) ?? null;
    }
    if (ts.isCallExpression(init) && ts.isIdentifier(init.expression)) {
      const name = init.expression.text;
      return localImports.get(name) ?? factoryToPackage.get(name) ?? null;
    }
    return null;
  }

  /**
   * Check if a file path matches common test file patterns.
   * Used to exclude test files from violation output by default.
   */
  private isTestFile(filePath: string): boolean {
    const testPatterns = [
      '/__tests__/',
      '/__mocks__/',
      '.test.ts',
      '.spec.ts',
      '.test.tsx',
      '.spec.tsx',
      '/tests/',
      '/test/',
      '.test.js',
      '.spec.js',
      '.e2e-spec.ts',
      '.e2e-spec.js',
    ];
    return testPatterns.some((pattern) => filePath.includes(pattern));
  }

  /**
   * Get the TypeScript program
   */
  public getProgram(): ts.Program {
    return this.program;
  }

  public getPlugins(): DetectorPlugin[] {
    return this.plugins;
  }
}
