/**
 * Return Value Checker Plugin
 *
 * Detects functions that return error/validation results that must be checked.
 * This pattern covers ~7% of contracts (validator, joi, ajv, yup).
 *
 * Examples:
 *   - const result = validator.isEmail(email); if (!result) {...}
 *   - const { error } = schema.validate(data); if (error) {...}
 *   - const valid = ajv.validate(schema, data); if (!valid) {...}
 *
 * NOTE: This is a simplified implementation. Full data flow analysis would
 * require tracking values across multiple statements and function calls.
 */

import * as ts from 'typescript';
import { DetectorPlugin, PluginContext, NodeContext, Detection } from '../types/index.js';

/**
 * Return Value Checker
 *
 * Tracks function calls that return values and checks if those values are used.
 * Simplified implementation focusing on same-statement patterns.
 */
export class ReturnValueChecker implements DetectorPlugin {
  name = 'ReturnValueChecker';
  version = '1.0.0';
  description = 'Detects functions whose return values must be checked';

  // Track variable declarations with function call initializers
  // Map: variable symbol -> {packageName, functionName, declaration}
  private returnValueTracking = new Map<
    ts.Symbol,
    {
      packageName: string;
      functionName: string;
      declaration: ts.VariableDeclaration;
    }
  >();

  /**
   * Initialize plugin
   */
  public initialize(_context: PluginContext): void {
    this.returnValueTracking.clear();
  }

  /**
   * Reset state before each file
   */
  public beforeTraversal(_sourceFile: ts.SourceFile, _context: PluginContext): void {
    this.returnValueTracking.clear();
  }

  /**
   * Track variable declarations with function call initializers.
   *
   * Handles both sync and async patterns:
   *   const result = validator.isEmail(email)        → sync
   *   const result = await client.createUser(data)   → async
   *   const { data, error } = await supabase.from('x').select()  → async destructuring
   */
  public onVariableDeclaration(node: ts.VariableDeclaration, context: NodeContext): Detection[] {
    if (!node.initializer) {
      return [];
    }

    let callExpr: ts.CallExpression | null = null;
    let isAsync = false;

    // Direct call: const x = pkg.method()
    if (ts.isCallExpression(node.initializer)) {
      callExpr = node.initializer;
    }

    // Awaited call: const x = await pkg.method()
    if (
      ts.isAwaitExpression(node.initializer) &&
      ts.isCallExpression(node.initializer.expression)
    ) {
      callExpr = node.initializer.expression;
      isAsync = true;
    }

    if (!callExpr) {
      return [];
    }

    // Get package and function name
    const info = this.getCallInfo(callExpr, context);
    if (!info) {
      return [];
    }

    // Track this variable for symbol-based usage checking
    const symbol = context.typeChecker.getSymbolAtLocation(node.name);
    if (symbol) {
      this.returnValueTracking.set(symbol, {
        packageName: info.packageName,
        functionName: info.functionName,
        declaration: node,
      });
    }

    // Generate detection immediately (contract matching determines if it's a real violation)
    return [
      {
        pluginName: this.name,
        pattern: isAsync ? 'return-value-async' : 'return-value',
        node: callExpr,
        packageName: info.packageName,
        functionName: info.functionName,
        confidence: 'medium', // Medium because we're not doing full flow analysis
        metadata: {
          variableName: node.name.getText(),
          isAsync,
        },
      },
    ];
  }

  /**
   * Get package and function name from call expression
   */
  private getCallInfo(
    node: ts.CallExpression,
    context: NodeContext
  ): { packageName: string; functionName: string } | null {
    const funcExpr = node.expression;

    // Case 1: Direct call (validate, isEmail)
    if (ts.isIdentifier(funcExpr)) {
      const importInfo = context.importMap.get(funcExpr.text);
      if (importInfo) {
        return {
          packageName: importInfo.packageName,
          functionName: funcExpr.text,
        };
      }
    }

    // Case 2: Property access (validator.isEmail, schema.validate)
    if (ts.isPropertyAccessExpression(funcExpr)) {
      const object = funcExpr.expression;
      const methodName = funcExpr.name.text;

      if (ts.isIdentifier(object)) {
        const importInfo = context.importMap.get(object.text);
        if (importInfo) {
          return {
            packageName: importInfo.packageName,
            functionName: methodName,
          };
        }
      }
    }

    return null;
  }

  /**
   * Note: In a full implementation, we would:
   *
   * 1. Track all variable usages (onIdentifier)
   * 2. Check if variables are:
   *    - Used in conditionals (if (result), if (!result))
   *    - Used in property access (result.error, result.valid)
   *    - Returned or passed to other functions
   * 3. At end of function scope, report violations for unchecked variables
   *
   * This would require:
   * - Scope tracking (knowing when we enter/exit functions)
   * - Usage tracking (recording all places a variable is used)
   * - Heuristic analysis (determining if usage constitutes a "check")
   *
   * For now, we just detect the pattern and report it immediately.
   * Contract matching will determine if it's actually a violation.
   */
}
