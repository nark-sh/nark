/**
 * Property Chain Detector Plugin
 *
 * Detects property access chains of arbitrary depth (2+ levels).
 * This pattern covers ~35% of contracts.
 *
 * Examples:
 *   - prisma.user.create() (2 levels)
 *   - openai.chat.completions.create() (3 levels)
 *   - stripe.customers.subscriptions.items.create() (4 levels)
 *   - aws.s3.getObject().promise() (2 levels + method call)
 */

import * as ts from 'typescript';
import { DetectorPlugin, PluginContext, NodeContext, Detection } from '../types/index.js';
import type { InstanceTrackerPlugin } from './instance-tracker.js';

/**
 * Property Chain Detector
 *
 * Detects calls on multi-level property chains.
 * Handles arbitrary depth (2-10+ levels).
 */
export class PropertyChainDetector implements DetectorPlugin {
  name = 'PropertyChainDetector';
  version = '1.0.0';
  description = 'Detects property access chains of arbitrary depth';

  // Track instance variables (e.g., const prisma = new PrismaClient())
  private instanceMap = new Map<string, string>(); // variable name -> package name

  // Optional shared instance tracker (for factory-created instances)
  private instanceTracker?: InstanceTrackerPlugin;

  constructor(instanceTracker?: InstanceTrackerPlugin) {
    this.instanceTracker = instanceTracker;
  }

  /**
   * Initialize plugin
   */
  public initialize(_context: PluginContext): void {
    // Reset instance tracking for each file
    this.instanceMap.clear();
  }

  /**
   * Reset state before each file
   */
  public beforeTraversal(_sourceFile: ts.SourceFile, _context: PluginContext): void {
    this.instanceMap.clear();
  }

  /**
   * Track variable declarations that create instances
   *
   * Example: const prisma = new PrismaClient()
   */
  public onVariableDeclaration(node: ts.VariableDeclaration, context: NodeContext): Detection[] {
    // Check if initializer is a new expression
    if (node.initializer && ts.isNewExpression(node.initializer)) {
      const newExpr = node.initializer;

      // Get the class being instantiated
      if (ts.isIdentifier(newExpr.expression)) {
        const className = newExpr.expression.text;

        // Check if class is from an import
        const importInfo = context.importMap.get(className);
        if (importInfo) {
          // Track this instance
          const varName = node.name.getText();
          this.instanceMap.set(varName, importInfo.packageName);
        }
      }
    }

    return [];
  }

  /**
   * Handle call expressions
   *
   * Look for calls on property chains: obj.prop1.prop2.method()
   */
  public onCallExpression(node: ts.CallExpression, context: NodeContext): Detection[] {
    const funcExpr = node.expression;

    // Only interested in property access
    if (!ts.isPropertyAccessExpression(funcExpr)) {
      return [];
    }

    // Build the full property chain
    const chain = this.buildPropertyChain(funcExpr);

    // Skip if we can't build a chain (complex expression)
    if (!chain) {
      return [];
    }

    // Only handle chains with depth >= 2
    // (Depth 1 is handled by ThrowingFunctionDetector)
    if (chain.properties.length < 2) {
      return [];
    }

    let packageName: string;
    let rootLabel: string;

    // Special case: this.member.method() — check the first property (member name) in instanceTracker
    // Example: this.channel.send() → 'channel' tracked as discord.js → packageName=discord.js
    if (chain.isThis) {
      if (!this.instanceTracker) return [];
      const memberName = chain.properties[0];
      const memberPackage = this.instanceTracker.resolveIdentifier(memberName);
      if (!memberPackage) return [];
      packageName = memberPackage;
      rootLabel = 'this';
    } else {
      // Normal case: identifier root — look up in imports / instance maps
      // First try to get the root identifier text directly (no type resolution needed)
      const rootIdentifierText = ts.isIdentifier(chain.root) ? chain.root.text : null;

      // Try type-checker symbol first, fall back to raw identifier text
      const rootSymbol = context.typeChecker.getSymbolAtLocation(chain.root);
      const resolvedName = rootSymbol?.name ?? rootIdentifierText;
      if (!resolvedName) {
        return [];
      }
      rootLabel = resolvedName;

      // Check if root is from an import
      const importInfo = context.importMap.get(resolvedName);
      if (importInfo) {
        packageName = importInfo.packageName;
      } else {
        // Check if root is a tracked instance variable (new X() pattern)
        const instancePackage = this.instanceMap.get(resolvedName);
        if (instancePackage) {
          packageName = instancePackage;
        } else if (this.instanceTracker) {
          // Check shared instance tracker (factory method pattern)
          const trackerPackage = this.instanceTracker.resolveIdentifier(resolvedName);
          if (trackerPackage) {
            packageName = trackerPackage;
          } else {
            return []; // Not from import or any tracked instance, skip
          }
        } else {
          return []; // Not from import or instance, skip
        }
      }
    }

    // Use the last property as functionName (the method being called).
    // The full chain is preserved in metadata for reference.
    // Example: stripe.charges.create() → functionName='create', chainStr='charges.create'
    const functionName = chain.properties[chain.properties.length - 1];
    const chainStr = chain.properties.join('.');

    return [
      {
        pluginName: this.name,
        pattern: 'property-chain',
        node,
        packageName,
        functionName,
        confidence: 'high',
        metadata: {
          depth: chain.properties.length,
          chain: [rootLabel, ...chain.properties],
          chainStr, // full chain e.g. 'charges.create' for stripe.charges.create()
        },
      },
    ];
  }

  /**
   * Build property chain from property access expression.
   *
   * Handles both simple property chains and builder/call-chain patterns.
   *
   * Simple:  obj.prop1.prop2.method → properties=['prop1','prop2','method'], root=obj
   * Builder: obj.from('t').select()  → properties=['from','select'], root=obj
   *   (call expressions in the middle are "skipped through" to collect the method name)
   *
   * This lets us detect Supabase builder patterns:
   *   supabase.from('users').select('*')  → root='supabase', functionName='select'
   *   supabase.from('users').insert(data) → root='supabase', functionName='insert'
   */
  private buildPropertyChain(node: ts.PropertyAccessExpression): {
    root: ts.Identifier | ts.Expression;
    isThis: boolean;
    properties: string[];
  } | null {
    const properties: string[] = [];
    let current: ts.Expression = node;

    // Walk up the chain, collecting property names.
    // When we encounter a CallExpression in the chain (builder pattern), walk through it.
    // When we encounter an ElementAccessExpression (bracket notation, e.g. zip.files['name']),
    // walk through it transparently — the bracket index is not part of the function chain.
    // This supports patterns like: zip.files['name'].async('string')
    while (ts.isPropertyAccessExpression(current)) {
      properties.unshift(current.name.text);
      current = current.expression;

      // Element access pattern: current may be an ElementAccessExpression (bracket notation),
      // e.g. zip.files['name'] in: zip.files['name'].async('string')
      // We unwrap it ONLY when the element access object is itself a PropertyAccessExpression
      // whose root will eventually resolve to an identifier (classic obj.prop['key'].method()
      // chain). We do NOT unwrap bare arr['key'].method() patterns (whose inner expression
      // is a plain Identifier) since those would introduce false positives for any array/map
      // access on a tracked-package variable.
      //
      // Implementation: use a while loop to handle nested element accesses like
      // zip.files['a']['b'].async(), unwrapping each level only when its inner expression
      // is still a PropertyAccessExpression (ensuring we stop before a bare Identifier root).
      while (
        ts.isElementAccessExpression(current) &&
        ts.isPropertyAccessExpression(current.expression)
      ) {
        current = current.expression;
      }

      // Builder pattern: current is now a CallExpression (e.g., supabase.from('users'))
      // Unwrap: collect the method name from the call's PropertyAccess, then continue walking
      while (ts.isCallExpression(current)) {
        if (ts.isPropertyAccessExpression(current.expression)) {
          properties.unshift(current.expression.name.text);
          current = current.expression.expression;
        } else if (ts.isIdentifier(current.expression)) {
          // Root is a direct function call: sharp() in sharp().resize()
          current = current.expression;
          break;
        } else {
          // Unsupported: complex expression inside builder chain
          return null;
        }
      }
    }

    // Root must be an identifier or the 'this' keyword
    const isThis = current.kind === ts.SyntaxKind.ThisKeyword;
    if (!ts.isIdentifier(current) && !isThis) {
      return null;
    }

    return {
      root: current,
      isThis,
      properties,
    };
  }
}
