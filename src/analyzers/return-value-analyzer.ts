/**
 * Return Value Analyzer
 * Detects unprotected error checks on function return values
 *
 * This analyzer tracks:
 * 1. Variable assignments from contract functions
 * 2. Error checks on those return values (null, false, error properties)
 * 3. Whether those checks are protected by try-catch
 *
 * Related: dev-notes/analyzer-enhancement/RETURN_VALUE_RESEARCH.md
 */

import * as ts from 'typescript';
import type { PackageContract, Postcondition } from '../types.js';

export interface ReturnValueCheck {
  /** Variable name holding the return value */
  variableName: string;
  /** Package the function belongs to */
  packageName: string;
  /** Function name that returned the value */
  functionName: string;
  /** Postcondition that requires error handling */
  postcondition: Postcondition;
  /** AST node where variable was declared */
  declarationNode: ts.Node;
  /** AST node where error check occurs (if any) */
  checkNode?: ts.Node;
  /** Whether the error check is protected by try-catch */
  isProtected: boolean;
}

export class ReturnValueAnalyzer {
  private sourceFile: ts.SourceFile;
  private contracts: Map<string, PackageContract>;
  // private typeChecker: ts.TypeChecker; // Reserved for future type-aware detection

  // Track return values that need error checking
  private trackedReturnValues: Map<string, {
    packageName: string;
    functionName: string;
    postcondition: Postcondition;
    declarationNode: ts.Node;
  }> = new Map();

  constructor(
    sourceFile: ts.SourceFile,
    contracts: Map<string, PackageContract>,
    _typeChecker: ts.TypeChecker // Reserved for future type-aware detection
  ) {
    this.sourceFile = sourceFile;
    this.contracts = contracts;
    // this.typeChecker = typeChecker; // Reserved for future type-aware detection
  }

  /**
   * Analyzes a function scope for unprotected return value checks
   */
  analyze(functionNode: ts.Node): ReturnValueCheck[] {
    const violations: ReturnValueCheck[] = [];

    // Step 1: Find all variable declarations from contract functions
    this.findReturnValueDeclarations(functionNode);

    // Step 2: For each tracked return value, find error checks
    for (const [varName, info] of this.trackedReturnValues.entries()) {
      const errorCheck = this.findErrorCheck(varName, functionNode);

      if (!errorCheck) {
        // No error check found - violation
        violations.push({
          variableName: varName,
          packageName: info.packageName,
          functionName: info.functionName,
          postcondition: info.postcondition,
          declarationNode: info.declarationNode,
          isProtected: false,
        });
      } else {
        // Error check found - verify it's in try-catch
        const isProtected = this.isNodeProtected(errorCheck, functionNode);

        if (!isProtected) {
          // Error check exists but not in try-catch - violation
          violations.push({
            variableName: varName,
            packageName: info.packageName,
            functionName: info.functionName,
            postcondition: info.postcondition,
            declarationNode: info.declarationNode,
            checkNode: errorCheck,
            isProtected: false,
          });
        }
      }
    }

    // Clear for next function
    this.trackedReturnValues.clear();

    return violations;
  }

  /**
   * Finds variable declarations that assign return values from contract functions
   */
  private findReturnValueDeclarations(scope: ts.Node): void {
    const visit = (node: ts.Node): void => {
      // Pattern: const result = validator.normalizeEmail(email)
      if (ts.isVariableDeclaration(node) && node.initializer) {
        const callInfo = this.extractContractFunctionCall(node.initializer);

        if (callInfo) {
          const varName = node.name.getText(this.sourceFile);
          this.trackedReturnValues.set(varName, {
            packageName: callInfo.packageName,
            functionName: callInfo.functionName,
            postcondition: callInfo.postcondition,
            declarationNode: node,
          });
        }
      }

      // Continue visiting children
      ts.forEachChild(node, visit);
    };

    visit(scope);
  }

  /**
   * Extracts contract function information from a call expression
   */
  private extractContractFunctionCall(node: ts.Node): {
    packageName: string;
    functionName: string;
    postcondition: Postcondition;
  } | null {
    if (!ts.isCallExpression(node)) {
      return null;
    }

    let functionName: string | null = null;
    let objectName: string | null = null;

    // Pattern: validator.normalizeEmail(...)
    if (ts.isPropertyAccessExpression(node.expression)) {
      functionName = node.expression.name.text;

      if (ts.isIdentifier(node.expression.expression)) {
        objectName = node.expression.expression.text;
      }
    }

    // Pattern: normalizeEmail(...) - direct call
    if (ts.isIdentifier(node.expression)) {
      functionName = node.expression.text;
    }

    if (!functionName) {
      return null;
    }

    // Check if this function belongs to any contract
    for (const [packageName, contract] of this.contracts.entries()) {
      // Simple heuristic: if objectName matches package name or is similar
      const packageMatches =
        objectName === packageName ||
        objectName === packageName.split('/').pop() ||
        objectName === packageName.replace(/@/g, '').replace(/\//g, '-');

      if (packageMatches || !objectName) {
        // Check if function exists in contract
        const func = contract.functions?.find(f => f.name === functionName);

        if (func && func.postconditions && func.postconditions.length > 0) {
          return {
            packageName,
            functionName,
            postcondition: func.postconditions[0], // Use first postcondition
          };
        }
      }
    }

    return null;
  }

  /**
   * Finds error check on a tracked return value
   * Looks for patterns like: if (!result), if (result.error), if (!result.success)
   */
  private findErrorCheck(varName: string, scope: ts.Node): ts.Node | null {
    let checkNode: ts.Node | null = null;

    const visit = (node: ts.Node): void => {
      // Pattern: if (!result) { ... }
      if (ts.isIfStatement(node)) {
        const condition = node.expression;

        // Check for: !variable
        if (ts.isPrefixUnaryExpression(condition) &&
            condition.operator === ts.SyntaxKind.ExclamationToken &&
            ts.isIdentifier(condition.operand) &&
            condition.operand.text === varName) {
          checkNode = node;
          return;
        }

        // Check for: variable (boolean check)
        if (ts.isIdentifier(condition) && condition.text === varName) {
          checkNode = node;
          return;
        }

        // Check for: !variable.property
        if (ts.isPrefixUnaryExpression(condition) &&
            condition.operator === ts.SyntaxKind.ExclamationToken &&
            ts.isPropertyAccessExpression(condition.operand) &&
            ts.isIdentifier(condition.operand.expression) &&
            condition.operand.expression.text === varName) {
          checkNode = node;
          return;
        }

        // Check for: variable.error or variable.success
        if (ts.isPropertyAccessExpression(condition) &&
            ts.isIdentifier(condition.expression) &&
            condition.expression.text === varName) {
          checkNode = node;
          return;
        }
      }

      // Pattern: result || defaultValue
      if (ts.isBinaryExpression(node) &&
          node.operatorToken.kind === ts.SyntaxKind.BarBarToken &&
          ts.isIdentifier(node.left) &&
          node.left.text === varName) {
        checkNode = node;
        return;
      }

      // Continue searching if not found
      if (!checkNode) {
        ts.forEachChild(node, visit);
      }
    };

    visit(scope);
    return checkNode;
  }

  /**
   * Checks if a node is protected by try-catch
   */
  private isNodeProtected(node: ts.Node, functionScope: ts.Node): boolean {
    let current: ts.Node | undefined = node;

    // Walk up the AST until we find a try block or reach function boundary
    while (current && current !== functionScope) {
      const parent: ts.Node | undefined = current.parent;

      if (!parent) {
        break;
      }

      // Check if we're inside a try block
      if (ts.isTryStatement(parent)) {
        // Check if current node is within the try block (not catch or finally)
        if (parent.tryBlock === current || this.isDescendantOf(node, parent.tryBlock)) {
          return true;
        }
      }

      current = parent;
    }

    return false;
  }

  /**
   * Checks if child is a descendant of parent node
   */
  private isDescendantOf(child: ts.Node, parent: ts.Node): boolean {
    let current: ts.Node | undefined = child;

    while (current) {
      if (current === parent) {
        return true;
      }
      current = current.parent;
    }

    return false;
  }
}
