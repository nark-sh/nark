/**
 * React Query specific analyzer
 * Detects error handling patterns for useQuery, useMutation, useInfiniteQuery
 */

import * as ts from 'typescript';
import type { HookCall, VariableUsage, HookErrorHandling } from '../types.js';

export class ReactQueryAnalyzer {
  private sourceFile: ts.SourceFile;

  constructor(sourceFile: ts.SourceFile, _checker: ts.TypeChecker) {
    this.sourceFile = sourceFile;
  }

  /**
   * Detects if a call expression is a React Query hook
   */
  isReactQueryHook(node: ts.CallExpression): string | null {
    if (!ts.isIdentifier(node.expression)) {
      return null;
    }

    const functionName = node.expression.text;
    const reactQueryHooks = ['useQuery', 'useMutation', 'useInfiniteQuery'];

    if (reactQueryHooks.includes(functionName)) {
      return functionName;
    }

    return null;
  }

  /**
   * Detects if a new expression is QueryClient
   */
  isQueryClient(node: ts.NewExpression): boolean {
    if (!ts.isIdentifier(node.expression)) {
      return false;
    }

    return node.expression.text === 'QueryClient';
  }

  /**
   * Extracts hook call information including options and return values
   */
  extractHookCall(node: ts.CallExpression, hookName: string): HookCall | null {
    const location = this.sourceFile.getLineAndCharacterOfPosition(node.getStart());

    const hookCall: HookCall = {
      hookName: hookName as any,
      location: {
        file: this.sourceFile.fileName,
        line: location.line + 1,
        column: location.character + 1,
      },
      returnValues: new Map(),
      options: {},
    };

    // Extract options object (first argument for hooks)
    if (node.arguments.length > 0) {
      const optionsArg = node.arguments[0];
      if (ts.isObjectLiteralExpression(optionsArg)) {
        this.parseHookOptions(optionsArg, hookCall);
      }
    }

    // Extract return values from destructuring
    const parent = node.parent;
    if (parent && ts.isVariableDeclaration(parent)) {
      this.parseReturnValues(parent, hookCall);
    }

    return hookCall;
  }

  /**
   * Parses hook options object to detect callbacks
   */
  private parseHookOptions(options: ts.ObjectLiteralExpression, hookCall: HookCall): void {
    for (const property of options.properties) {
      if (!ts.isPropertyAssignment(property)) continue;
      if (!ts.isIdentifier(property.name)) continue;

      const propName = property.name.text;

      switch (propName) {
        case 'onError':
          hookCall.options.onError = true;
          break;
        case 'onMutate':
          hookCall.options.onMutate = true;
          break;
        case 'onSuccess':
          hookCall.options.onSuccess = true;
          break;
        case 'retry':
          hookCall.options.retry = this.parseRetryOption(property.initializer);
          break;
      }
    }
  }

  /**
   * Parses retry option to determine type
   */
  private parseRetryOption(node: ts.Expression): 'default' | 'number' | 'boolean' | 'function' {
    if (ts.isNumericLiteral(node)) {
      return 'number';
    }
    if (node.kind === ts.SyntaxKind.TrueKeyword || node.kind === ts.SyntaxKind.FalseKeyword) {
      return 'boolean';
    }
    if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
      return 'function';
    }
    return 'default';
  }

  /**
   * Parses destructured return values from hook
   */
  private parseReturnValues(declaration: ts.VariableDeclaration, hookCall: HookCall): void {
    if (!declaration.name || !ts.isObjectBindingPattern(declaration.name)) {
      return;
    }

    for (const element of declaration.name.elements) {
      if (!ts.isBindingElement(element)) continue;

      // Handle both: { error } and { error: customError }
      const propertyName = element.propertyName
        ? (ts.isIdentifier(element.propertyName) ? element.propertyName.text : '')
        : (ts.isIdentifier(element.name) ? element.name.text : '');

      const variableName = ts.isIdentifier(element.name) ? element.name.text : '';

      if (propertyName && variableName) {
        hookCall.returnValues.set(variableName, propertyName);
      }
    }
  }

  /**
   * Tracks how a variable is used in the component scope
   */
  trackVariableUsage(variableName: string, componentNode: ts.Node): VariableUsage {
    const usage: VariableUsage = {
      variableName,
      propertyName: '',
      declaredAt: {
        file: this.sourceFile.fileName,
        line: 0,
      },
      usedIn: {
        conditionals: 0,
        jsxExpressions: 0,
        callbacks: 0,
      },
    };

    const self = this;

    // Walk the component to find variable usage
    function visit(node: ts.Node): void {
      // Check for if statements: if (isError) { ... }
      if (ts.isIfStatement(node)) {
        const condition = node.expression;
        if (self.referencesVariable(condition, variableName)) {
          usage.usedIn.conditionals++;
        }
      }

      // Check for ternary: isError ? <Error /> : <Success />
      if (ts.isConditionalExpression(node)) {
        if (self.referencesVariable(node.condition, variableName)) {
          usage.usedIn.conditionals++;
        }
      }

      // Check for JSX: {isError && <Error />}
      if (ts.isJsxExpression(node)) {
        if (node.expression && self.referencesVariable(node.expression, variableName)) {
          usage.usedIn.jsxExpressions++;
        }
      }

      // Check for logical expressions: isError && doSomething()
      if (ts.isBinaryExpression(node)) {
        if (node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
            node.operatorToken.kind === ts.SyntaxKind.BarBarToken) {
          if (self.referencesVariable(node.left, variableName)) {
            usage.usedIn.conditionals++;
          }
        }
      }

      ts.forEachChild(node, visit);
    }

    visit(componentNode);
    return usage;
  }

  /**
   * Checks if an expression references a specific variable
   */
  private referencesVariable(node: ts.Node, variableName: string): boolean {
    if (ts.isIdentifier(node) && node.text === variableName) {
      return true;
    }

    // Check for property access: error.message
    if (ts.isPropertyAccessExpression(node)) {
      if (ts.isIdentifier(node.expression) && node.expression.text === variableName) {
        return true;
      }
    }

    // Check for optional chaining: error?.message
    if (ts.isNonNullExpression(node)) {
      return this.referencesVariable(node.expression, variableName);
    }

    let found = false;
    ts.forEachChild(node, (child) => {
      if (this.referencesVariable(child, variableName)) {
        found = true;
      }
    });

    return found;
  }

  /**
   * Analyzes error handling for a React Query hook call
   */
  analyzeHookErrorHandling(hookCall: HookCall, componentNode: ts.Node): HookErrorHandling {
    const analysis: HookErrorHandling = {
      hasErrorStateCheck: false,
      hasOnErrorCallback: false,
      hasGlobalHandler: false, // TODO: Detect from QueryClient
      errorCheckedBeforeDataAccess: false,
    };

    // Check if onError callback is present
    if (hookCall.options.onError) {
      analysis.hasOnErrorCallback = true;
    }

    // Track error/isError variables
    const errorVars = Array.from(hookCall.returnValues.entries())
      .filter(([_, propName]) => propName === 'error' || propName === 'isError')
      .map(([varName, _]) => varName);

    // Check if any error variables are used
    for (const errorVar of errorVars) {
      const usage = this.trackVariableUsage(errorVar, componentNode);
      if (usage.usedIn.conditionals > 0 || usage.usedIn.jsxExpressions > 0) {
        analysis.hasErrorStateCheck = true;
        break;
      }
    }

    // Check for optimistic update pattern (onMutate + onError)
    if (hookCall.hookName === 'useMutation') {
      if (hookCall.options.onMutate && hookCall.options.onError) {
        // TODO: Verify rollback logic in onError
        analysis.hasOptimisticUpdateRollback = true;
      } else if (hookCall.options.onMutate && !hookCall.options.onError) {
        analysis.hasOptimisticUpdateRollback = false;
      }
    }

    // Analyze retry configuration
    if (hookCall.options.retry) {
      analysis.retryAnalysis = {
        type: hookCall.options.retry,
        avoidsClientErrors: hookCall.options.retry === 'function', // Assume function checks status
      };
    }

    return analysis;
  }

  /**
   * Finds the component (function) containing a node
   */
  findContainingComponent(node: ts.Node): ts.Node | null {
    let current = node.parent;
    while (current) {
      // Check for function component
      if (ts.isFunctionDeclaration(current) ||
          ts.isFunctionExpression(current) ||
          ts.isArrowFunction(current)) {
        // Verify it looks like a React component (PascalCase name or returns JSX)
        if (this.looksLikeComponent(current)) {
          return current;
        }
      }
      current = current.parent;
    }
    return null;
  }

  /**
   * Heuristic to check if a function looks like a React component
   */
  private looksLikeComponent(node: ts.FunctionDeclaration | ts.FunctionExpression | ts.ArrowFunction): boolean {
    // Check for PascalCase name
    if (ts.isFunctionDeclaration(node) && node.name) {
      const name = node.name.text;
      if (name && name[0] === name[0].toUpperCase()) {
        return true;
      }
    }

    // Check if it returns JSX
    // This is a simplified check - a full check would need to walk the function body
    const bodyText = node.body?.getText(this.sourceFile) || '';
    if (bodyText.includes('<') && bodyText.includes('/>')) {
      return true;
    }

    return false;
  }

  /**
   * Detects QueryClient configuration and global error handlers
   */
  detectGlobalHandlers(sourceFile: ts.SourceFile): {
    hasQueryCacheOnError: boolean;
    hasMutationCacheOnError: boolean;
  } {
    const result = {
      hasQueryCacheOnError: false,
      hasMutationCacheOnError: false,
    };

    const self = this;

    function visit(node: ts.Node): void {
      // Look for: new QueryClient({ ... })
      if (ts.isNewExpression(node) && self.isQueryClient(node)) {
        if (node.arguments && node.arguments.length > 0) {
          const config = node.arguments[0];
          if (ts.isObjectLiteralExpression(config)) {
            // Check for queryCache and mutationCache
            for (const prop of config.properties) {
              if (!ts.isPropertyAssignment(prop)) continue;
              if (!ts.isIdentifier(prop.name)) continue;

              if (prop.name.text === 'queryCache') {
                result.hasQueryCacheOnError = self.hasOnErrorCallback(prop.initializer);
              } else if (prop.name.text === 'mutationCache') {
                result.hasMutationCacheOnError = self.hasOnErrorCallback(prop.initializer);
              }
            }
          }
        }
      }

      ts.forEachChild(node, visit);
    }

    visit(sourceFile);
    return result;
  }

  /**
   * Checks if a QueryCache/MutationCache has onError callback
   */
  private hasOnErrorCallback(node: ts.Expression): boolean {
    // Look for: new QueryCache({ onError: ... })
    if (ts.isNewExpression(node) && node.arguments && node.arguments.length > 0) {
      const config = node.arguments[0];
      if (ts.isObjectLiteralExpression(config)) {
        for (const prop of config.properties) {
          if (ts.isPropertyAssignment(prop) &&
              ts.isIdentifier(prop.name) &&
              prop.name.text === 'onError') {
            return true;
          }
        }
      }
    }
    return false;
  }
}
