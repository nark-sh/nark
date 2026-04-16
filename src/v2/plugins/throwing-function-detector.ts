/**
 * Throwing Function Detector Plugin
 *
 * Detects direct function calls that can throw exceptions.
 * This is the most common pattern, covering ~45% of contracts.
 *
 * Examples:
 *   - axios.get() - throws AxiosError
 *   - bcrypt.hash() - throws on invalid input
 *   - jwt.sign() - throws on invalid payload
 *   - sharp() - throws on invalid image
 */

import * as ts from 'typescript';
import { DetectorPlugin, PluginContext, NodeContext, Detection } from '../types/index.js';
import type { InstanceTrackerPlugin } from './instance-tracker.js';

/**
 * Throwing Function Detector
 *
 * Detects calls to functions that may throw exceptions.
 * Handles both:
 *   1. Direct calls: axios.get(), bcrypt.hash()
 *   2. Property chains: prisma.user.create() (delegated to PropertyChainDetector for depth > 1)
 */
export class ThrowingFunctionDetector implements DetectorPlugin {
  name = 'ThrowingFunctionDetector';
  version = '1.0.0';
  description = 'Detects direct function calls that can throw exceptions';

  private instanceTracker?: InstanceTrackerPlugin;

  constructor(instanceTracker?: InstanceTrackerPlugin) {
    this.instanceTracker = instanceTracker;
  }

  /**
   * Initialize plugin with context
   */
  public initialize(_context: PluginContext): void {
    // Context not needed for this plugin
  }

  /**
   * Handle call expressions
   *
   * Triggered for every function call in the AST.
   */
  public onCallExpression(node: ts.CallExpression, context: NodeContext): Detection[] {
    const funcExpr = node.expression;

    // Case 1: Property access (obj.method())
    if (ts.isPropertyAccessExpression(funcExpr)) {
      return this.handlePropertyAccessCall(funcExpr, node, context);
    }

    // Case 2: Direct identifier (fn())
    if (ts.isIdentifier(funcExpr)) {
      return this.handleDirectCall(funcExpr, node, context);
    }

    // Case 3: Other expressions (new Foo(), (fn)(), etc.)
    // For now, we'll skip these - can add support later if needed
    return [];
  }

  /**
   * Handle property access calls: obj.method()
   *
   * Examples:
   *   - axios.get()
   *   - jwt.sign()
   *   - sharp()
   */
  private handlePropertyAccessCall(
    propAccess: ts.PropertyAccessExpression,
    callNode: ts.CallExpression,
    context: NodeContext
  ): Detection[] {
    // Build the property chain
    const chain = this.buildPropertyChain(propAccess);

    // Skip if we can't build a simple chain (complex expression)
    if (!chain) {
      return [];
    }

    // For depth 1 (obj.method), handle here
    // For depth > 1 (obj.prop.method), let PropertyChainDetector handle it
    if (chain.properties.length > 1) {
      return []; // PropertyChainDetector will handle this
    }

    // Get the root object (e.g., 'axios' in axios.get())
    // Fall back to identifier text when TypeScript can't resolve the symbol
    // (e.g. when the package has no .d.ts declarations in the project's node_modules).
    const rootSymbol = context.typeChecker.getSymbolAtLocation(chain.root);
    const rootName = rootSymbol?.name ?? chain.root.text;

    // Check if root is from an import
    const importInfo = context.importMap.get(rootName);
    let packageName: string;

    if (importInfo) {
      packageName = importInfo.packageName;
    } else {
      // Check instance tracker for factory-created instances
      if (this.instanceTracker) {
        const instancePackage = this.instanceTracker.resolveIdentifier(rootName);
        if (instancePackage) {
          packageName = instancePackage;
        } else {
          return []; // Not from an import or known instance, skip
        }
      } else {
        return []; // Not from an import, skip
      }
    }
    const functionName = chain.properties[0]; // e.g., 'get' in axios.get()

    // Include type name when available for class-level disambiguation.
    // e.g., channel: GuildChannel → instanceTypeName='GuildChannel'
    // Used by ContractMatcher to resolve dotted-name ambiguity (Message.delete vs GuildChannel.delete).
    const instanceTypeName = typeof this.instanceTracker?.resolveIdentifierTypeName === 'function'
      ? this.instanceTracker.resolveIdentifierTypeName(rootName) ?? undefined
      : undefined;

    return [
      {
        pluginName: this.name,
        pattern: 'throwing-function',
        node: callNode,
        packageName,
        functionName,
        confidence: 'high',
        metadata: {
          depth: 1,
          chain: [rootName, ...chain.properties],
          ...(instanceTypeName ? { instanceTypeName } : {}),
        },
      },
    ];
  }

  /**
   * Handle direct function calls: fn()
   *
   * Examples:
   *   - get() // where get was imported from axios
   *   - hash() // where hash was imported from bcryptjs
   */
  private handleDirectCall(
    identifier: ts.Identifier,
    callNode: ts.CallExpression,
    context: NodeContext
  ): Detection[] {
    // Get symbol for identifier. Fall back to the raw identifier text when
    // TypeScript can't resolve the symbol (e.g. missing .d.ts declarations).
    const symbol = context.typeChecker.getSymbolAtLocation(identifier);
    const identName = symbol?.name ?? identifier.text;

    // Check if this is from an import
    const importInfo = context.importMap.get(identName);
    if (!importInfo) {
      return []; // Not from an import, skip
    }

    const packageName = importInfo.packageName;
    const functionName = importInfo.importedName;

    return [
      {
        pluginName: this.name,
        pattern: 'throwing-function',
        node: callNode,
        packageName,
        functionName,
        confidence: 'high',
        metadata: {
          depth: 0,
          importKind: importInfo.kind,
        },
      },
    ];
  }

  /**
   * Handle tagged template expressions: sql`SELECT ...`
   *
   * These are semantically equivalent to function calls. When the tag identifier
   * is a tracked instance (e.g., sql = neon(...)) or a cross-module re-exported
   * neon function, we emit a detection for the 'neon' function in the package.
   */
  public onTaggedTemplateExpression(node: ts.TaggedTemplateExpression, context: NodeContext): Detection[] {
    const tag = node.tag;

    // Only handle simple identifier tags (e.g., sql`...`)
    if (!ts.isIdentifier(tag)) {
      return [];
    }

    const symbol = context.typeChecker.getSymbolAtLocation(tag);
    const tagName = symbol?.name ?? tag.text;

    // 1. Check instance tracker — handles: const sql = neon(url); sql`...`
    if (this.instanceTracker) {
      const pkg = this.instanceTracker.resolveIdentifier(tagName);
      if (pkg) {
        return [{
          pluginName: this.name,
          pattern: 'throwing-function',
          node,
          packageName: pkg,
          functionName: 'neon',
          confidence: 'high',
          metadata: { taggedTemplate: true, tagName },
        }];
      }
    }

    // 2. Check importMap — handles cross-module re-exports resolved by TraversalEngine:
    //    import { sql } from "@/sql"  →  packageName resolved to "@neondatabase/serverless"
    const importInfo = context.importMap.get(tagName);
    if (importInfo) {
      return [{
        pluginName: this.name,
        pattern: 'throwing-function',
        node,
        packageName: importInfo.packageName,
        functionName: 'neon',
        confidence: 'high',
        metadata: { taggedTemplate: true, tagName },
      }];
    }

    return [];
  }

  /**
   * Build property chain from property access expression
   *
   * Example: obj.prop.method -> { root: obj, properties: ['prop', 'method'] }
   * Returns null if root is not an identifier (e.g., complex expression)
   */
  private buildPropertyChain(node: ts.PropertyAccessExpression): {
    root: ts.Identifier;
    properties: string[];
  } | null {
    const properties: string[] = [];
    let current: ts.Expression = node;

    // Walk up the chain
    while (ts.isPropertyAccessExpression(current)) {
      properties.unshift(current.name.text);
      current = current.expression;
    }

    // Root must be an identifier for us to handle it
    if (!ts.isIdentifier(current)) {
      return null; // Skip complex expressions
    }

    return {
      root: current,
      properties,
    };
  }
}
