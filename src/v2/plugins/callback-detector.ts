/**
 * Callback Detector Plugin
 *
 * Detects error-first callback patterns common in Node.js APIs.
 * This pattern covers ~5% of contracts (declining, replaced by Promises).
 *
 * Examples:
 *   - fs.readFile('file', (err, data) => {...})
 *   - mysql.query('SELECT...', (err, results) => {...})
 *   - async.map(items, (item, callback) => {...}, (err, results) => {...})
 */

import * as ts from 'typescript';
import { DetectorPlugin, PluginContext, NodeContext, Detection } from '../types/index.js';

/**
 * Callback Detector
 *
 * Detects calls with error-first callbacks (err as first parameter).
 */
export class CallbackDetector implements DetectorPlugin {
  name = 'CallbackDetector';
  version = '1.0.0';
  description = 'Detects error-first callback patterns';

  // Common error parameter names
  private readonly errorParamNames = new Set(['err', 'error', 'e']);

  /**
   * Initialize plugin
   */
  public initialize(_context: PluginContext): void {
    // No initialization needed
  }

  /**
   * Handle call expressions
   *
   * Look for calls with callback arguments that have error-first signature
   */
  public onCallExpression(node: ts.CallExpression, context: NodeContext): Detection[] {
    // Find callback arguments (arrow functions or function expressions)
    const callbacks = node.arguments.filter(
      (arg) => ts.isArrowFunction(arg) || ts.isFunctionExpression(arg)
    );

    if (callbacks.length === 0) {
      return [];
    }

    const detections: Detection[] = [];

    // Check each callback for error-first signature
    for (const callback of callbacks) {
      const func = callback as ts.ArrowFunction | ts.FunctionExpression;

      // Check if first parameter looks like an error parameter
      if (func.parameters.length > 0) {
        const firstParam = func.parameters[0];
        const paramName = firstParam.name.getText().toLowerCase();

        if (this.isErrorParameter(paramName)) {
          // This is an error-first callback
          const packageName = this.getPackageName(node, context);

          if (packageName) {
            const functionName = this.getFunctionName(node);

            detections.push({
              pluginName: this.name,
              pattern: 'error-first-callback',
              node: callback,
              packageName,
              functionName,
              confidence: 'medium', // Medium because parameter naming is heuristic
              metadata: {
                errorParam: paramName,
                parameterCount: func.parameters.length,
              },
            });
          }
        }
      }
    }

    return detections;
  }

  /**
   * Check if parameter name indicates an error parameter
   */
  private isErrorParameter(paramName: string): boolean {
    return this.errorParamNames.has(paramName);
  }

  /**
   * Get package name from call expression
   *
   * Handles: fs.readFile, client.query, async.map
   */
  private getPackageName(node: ts.CallExpression, context: NodeContext): string | null {
    const funcExpr = node.expression;

    // Case 1: Direct call (readFile) - unlikely for Node.js APIs
    if (ts.isIdentifier(funcExpr)) {
      const importInfo = context.importMap.get(funcExpr.text);
      return importInfo?.packageName || null;
    }

    // Case 2: Property access (fs.readFile, client.query)
    if (ts.isPropertyAccessExpression(funcExpr)) {
      const object = funcExpr.expression;

      if (ts.isIdentifier(object)) {
        const importInfo = context.importMap.get(object.text);
        return importInfo?.packageName || null;
      }

      // Handle deeper chains (db.connection.query)
      const root = this.getRoot(funcExpr);
      if (root) {
        const importInfo = context.importMap.get(root);
        return importInfo?.packageName || null;
      }
    }

    return null;
  }

  /**
   * Get function name from call expression
   */
  private getFunctionName(node: ts.CallExpression): string {
    const funcExpr = node.expression;

    if (ts.isIdentifier(funcExpr)) {
      return funcExpr.text;
    }

    if (ts.isPropertyAccessExpression(funcExpr)) {
      // Build full chain: obj.method or obj.prop.method
      const chain = this.buildChain(funcExpr);
      return chain.join('.');
    }

    return 'unknown';
  }

  /**
   * Build property chain
   */
  private buildChain(node: ts.PropertyAccessExpression): string[] {
    const chain: string[] = [];
    let current: ts.Expression = node;

    while (ts.isPropertyAccessExpression(current)) {
      chain.unshift(current.name.text);
      current = current.expression;
    }

    return chain;
  }

  /**
   * Get root identifier from property chain
   */
  private getRoot(node: ts.PropertyAccessExpression): string | null {
    let current: ts.Expression = node;

    while (ts.isPropertyAccessExpression(current)) {
      current = current.expression;
    }

    if (ts.isIdentifier(current)) {
      return current.text;
    }

    return null;
  }
}
