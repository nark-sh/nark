/**
 * AST Traversal Engine
 *
 * Core component that walks the TypeScript AST and emits events to detector plugins.
 * Implements single-pass traversal for performance.
 */

import * as ts from 'typescript';
import {
  DetectorPlugin,
  PluginContext,
  NodeContext,
  Detection,
  ControlFlowAnalyzer,
  ImportInfo,
} from '../types/index.js';
import { ImportTracker } from './import-tracker.js';
import { ControlFlowAnalysis } from './control-flow-analyzer.js';

/**
 * Event types emitted during traversal
 */
type TraversalEvent =
  | 'callExpression'
  | 'propertyAccess'
  | 'variableDeclaration'
  | 'returnStatement'
  | 'functionExpression'
  | 'identifier'
  | 'binaryExpression'
  | 'conditionalExpression'
  | 'taggedTemplateExpression';

/**
 * Event handler function type
 */
type EventHandler = (node: any, context: NodeContext) => Detection[];

/**
 * AST Traversal Engine
 *
 * Walks TypeScript AST depth-first, emitting events to registered plugins.
 */
export class TraversalEngine {
  private program: ts.Program;
  private typeChecker: ts.TypeChecker;
  private plugins: DetectorPlugin[] = [];
  private importTracker: ImportTracker;
  private controlFlow: ControlFlowAnalyzer;
  private knownPackages?: Set<string>;
  private reExportMap?: Map<string, Map<string, string>>;

  // Event handlers map (event type -> list of handlers)
  private eventHandlers: Map<TraversalEvent, EventHandler[]> = new Map();

  // Plugin context (shared across all plugins)
  private pluginContext!: PluginContext;

  constructor(
    program: ts.Program,
    knownPackages?: Set<string>,
    reExportMap?: Map<string, Map<string, string>>
  ) {
    this.program = program;
    this.typeChecker = program.getTypeChecker();
    this.knownPackages = knownPackages;
    this.reExportMap = reExportMap;
    this.importTracker = new ImportTracker(this.typeChecker, knownPackages);
    this.controlFlow = new ControlFlowAnalysis();

    // Initialize event handler map
    this.initializeEventHandlers();
  }

  /**
   * Register a detector plugin
   */
  public registerPlugin(plugin: DetectorPlugin): void {
    this.plugins.push(plugin);

    // Register event handlers from plugin
    if (plugin.onCallExpression) {
      this.addEventListener('callExpression', plugin.onCallExpression.bind(plugin));
    }
    if (plugin.onPropertyAccess) {
      this.addEventListener('propertyAccess', plugin.onPropertyAccess.bind(plugin));
    }
    if (plugin.onVariableDeclaration) {
      this.addEventListener('variableDeclaration', plugin.onVariableDeclaration.bind(plugin));
    }
    if (plugin.onReturnStatement) {
      this.addEventListener('returnStatement', plugin.onReturnStatement.bind(plugin));
    }
    if (plugin.onFunctionExpression) {
      this.addEventListener('functionExpression', plugin.onFunctionExpression.bind(plugin));
    }
    if (plugin.onIdentifier) {
      this.addEventListener('identifier', plugin.onIdentifier.bind(plugin));
    }
    if (plugin.onBinaryExpression) {
      this.addEventListener('binaryExpression', plugin.onBinaryExpression.bind(plugin));
    }
    if (plugin.onConditionalExpression) {
      this.addEventListener('conditionalExpression', plugin.onConditionalExpression.bind(plugin));
    }
    if (plugin.onTaggedTemplateExpression) {
      this.addEventListener('taggedTemplateExpression', plugin.onTaggedTemplateExpression.bind(plugin));
    }
  }

  /**
   * Analyze a source file and return all detections
   */
  public analyze(sourceFile: ts.SourceFile): Detection[] {
    // Build import map for this file
    const importMap = this.importTracker.extractImports(sourceFile);

    // Augment importMap with cross-module re-export resolution.
    // Resolves patterns like: import { sql } from "@/sql"
    // where sql.ts exports: export const sql = neon(connectionString)
    if (this.reExportMap && this.reExportMap.size > 0) {
      this.resolveReExports(sourceFile, importMap);
    }

    // Create plugin context
    this.pluginContext = {
      typeChecker: this.typeChecker,
      symbolTable: new Map(), // Populated lazily during traversal
      importMap,
      controlFlow: this.controlFlow,
      sourceFile,
      program: this.program,
    };

    // Initialize plugins
    for (const plugin of this.plugins) {
      if (plugin.initialize) {
        plugin.initialize(this.pluginContext);
      }
    }

    // Call beforeTraversal hooks
    for (const plugin of this.plugins) {
      if (plugin.beforeTraversal) {
        plugin.beforeTraversal(sourceFile, this.pluginContext);
      }
    }

    // Traverse AST and collect detections
    const detections: Detection[] = [];
    this.traverseNode(sourceFile, undefined, 0, detections);

    // Call afterTraversal hooks
    for (const plugin of this.plugins) {
      if (plugin.afterTraversal) {
        plugin.afterTraversal(detections, this.pluginContext);
      }
    }

    return detections;
  }

  /**
   * Traverse a node and its children, emitting events
   */
  private traverseNode(
    node: ts.Node,
    parent: ts.Node | undefined,
    depth: number,
    detections: Detection[]
  ): void {
    // Set parent pointer on node if not already set.
    // TypeScript createProgram() does NOT set .parent by default, but
    // ControlFlowAnalysis.isInTryCatch() needs parent refs to walk up the AST.
    if (parent && !(node as any).parent) {
      (node as any).parent = parent;
    }

    // Create node context
    const nodeContext: NodeContext = {
      ...this.pluginContext,
      node,
      parent,
      depth,
    };

    // Emit events based on node type
    this.emitEventsForNode(node, nodeContext, detections);

    // Recursively traverse children
    ts.forEachChild(node, (child) => {
      this.traverseNode(child, node, depth + 1, detections);
    });
  }

  /**
   * Emit events for a node based on its type
   */
  private emitEventsForNode(node: ts.Node, context: NodeContext, detections: Detection[]): void {
    // Call expression: foo(), obj.method(), new Class()
    if (ts.isCallExpression(node)) {
      const results = this.emitEvent('callExpression', node, context);
      detections.push(...results);
    }

    // Property access: obj.prop
    if (ts.isPropertyAccessExpression(node)) {
      const results = this.emitEvent('propertyAccess', node, context);
      detections.push(...results);
    }

    // Variable declaration: const x = ...
    if (ts.isVariableDeclaration(node)) {
      const results = this.emitEvent('variableDeclaration', node, context);
      detections.push(...results);
    }

    // Return statement: return x
    if (ts.isReturnStatement(node)) {
      const results = this.emitEvent('returnStatement', node, context);
      detections.push(...results);
    }

    // Function expression: () => {}, function() {}
    if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
      const results = this.emitEvent('functionExpression', node, context);
      detections.push(...results);
    }

    // Identifier: variable names, function names
    if (ts.isIdentifier(node)) {
      const results = this.emitEvent('identifier', node, context);
      detections.push(...results);
    }

    // Binary expression: a + b, x === y
    if (ts.isBinaryExpression(node)) {
      const results = this.emitEvent('binaryExpression', node, context);
      detections.push(...results);
    }

    // Conditional expression: condition ? a : b
    if (ts.isConditionalExpression(node)) {
      const results = this.emitEvent('conditionalExpression', node, context);
      detections.push(...results);
    }

    // Tagged template expression: sql`SELECT * FROM users`
    if (ts.isTaggedTemplateExpression(node)) {
      const results = this.emitEvent('taggedTemplateExpression', node, context);
      detections.push(...results);
    }
  }

  /**
   * Emit an event to all registered handlers
   */
  private emitEvent(event: TraversalEvent, node: ts.Node, context: NodeContext): Detection[] {
    const handlers = this.eventHandlers.get(event) || [];
    const allDetections: Detection[] = [];

    for (const handler of handlers) {
      try {
        const detections = handler(node, context);
        allDetections.push(...detections);
      } catch (error) {
        // Log error but continue with other handlers
        console.error(`Error in event handler for ${event}:`, error);
      }
    }

    return allDetections;
  }

  /**
   * Add an event listener
   */
  private addEventListener(event: TraversalEvent, handler: EventHandler): void {
    if (!this.eventHandlers.has(event)) {
      this.eventHandlers.set(event, []);
    }
    this.eventHandlers.get(event)!.push(handler);
  }

  /**
   * Initialize event handler map
   */
  private initializeEventHandlers(): void {
    const events: TraversalEvent[] = [
      'callExpression',
      'propertyAccess',
      'variableDeclaration',
      'returnStatement',
      'functionExpression',
      'identifier',
      'binaryExpression',
      'conditionalExpression',
      'taggedTemplateExpression',
    ];

    for (const event of events) {
      this.eventHandlers.set(event, []);
    }
  }

  /**
   * Augment the per-file importMap with cross-module re-export resolution.
   *
   * When a file imports { sql } from "@/sql" and sql.ts exports:
   *   export const sql = neon(connectionString)
   * we remap sql's packageName from "@/sql" to "@neondatabase/serverless" so
   * downstream plugins treat it as an instance of the contracted package.
   */
  private resolveReExports(
    sourceFile: ts.SourceFile,
    importMap: Map<string, ImportInfo>
  ): void {
    const compilerOptions = this.program.getCompilerOptions();

    for (const [localName, importInfo] of importMap.entries()) {
      // Skip entries already pointing to a known contracted package
      if (this.knownPackages?.has(importInfo.packageName)) continue;

      // Try to resolve the module specifier (e.g. "@/sql", "./lib/db") to an absolute path
      const resolved = ts.resolveModuleName(
        importInfo.packageName,
        sourceFile.fileName,
        compilerOptions,
        ts.sys
      );
      if (!resolved.resolvedModule?.resolvedFileName) continue;

      const absPath = resolved.resolvedModule.resolvedFileName;
      const fileExports = this.reExportMap!.get(absPath);
      if (!fileExports) continue;

      const contractedPkg = fileExports.get(localName);
      if (!contractedPkg) continue;

      // Remap to the contracted package so plugins pick it up correctly
      importMap.set(localName, {
        ...importInfo,
        packageName: contractedPkg,
      });
    }
  }

  /**
   * Get program
   */
  public getProgram(): ts.Program {
    return this.program;
  }

  /**
   * Get type checker
   */
  public getTypeChecker(): ts.TypeChecker {
    return this.typeChecker;
  }

  /**
   * Get registered plugins
   */
  public getPlugins(): DetectorPlugin[] {
    return this.plugins;
  }
}
