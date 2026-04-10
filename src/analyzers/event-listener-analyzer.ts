/**
 * Event Listener Analyzer
 *
 * Detects missing required event listeners on instances of event-emitting classes.
 * This is a PATTERN-BASED analyzer that works for ANY package requiring event listeners.
 *
 * Examples:
 * - ws.WebSocket requires 'error' listener
 * - bull.Queue requires 'error' and 'failed' listeners
 * - archiver requires 'error' listener
 * - socket.io.Server requires 'error' listener
 *
 * Contract Configuration:
 * ```yaml
 * detection:
 *   class_names: ["WebSocket"]
 *   require_instance_tracking: true
 *   required_event_listeners:
 *     - event: "error"
 *       required: true
 *       severity: error
 * ```
 */

import * as ts from 'typescript';
import type { PackageContract, RequiredEventListener } from '../types.js';

export interface EventListenerCheck {
  packageName: string;
  className: string;
  variableName: string;
  missingEvent: string;
  requiredListener: RequiredEventListener;
  declarationNode: ts.Node;
}

interface TrackedInstance {
  packageName: string;
  className: string;
  requiredListeners: RequiredEventListener[];
  declarationNode: ts.Node;
  attachedEvents: Set<string>;
}

export class EventListenerAnalyzer {
  private sourceFile: ts.SourceFile;
  private contracts: Map<string, PackageContract>;
  // private typeChecker: ts.TypeChecker; // Reserved for future type-aware detection

  // Track instances requiring event listeners
  private trackedInstances: Map<string, TrackedInstance> = new Map();

  constructor(
    sourceFile: ts.SourceFile,
    contracts: Map<string, PackageContract>,
    _typeChecker: ts.TypeChecker  // Prefixed with _ to indicate intentionally unused
  ) {
    this.sourceFile = sourceFile;
    this.contracts = contracts;
    // this.typeChecker = typeChecker; // Reserved for future type-aware detection
  }

  /**
   * Main analysis entry point
   *
   * Steps:
   * 1. Find all instance declarations from contracts with required_event_listeners
   * 2. Find all .on(), .addEventListener(), .once() calls for tracked instances
   * 3. Check if all required listeners are attached
   * 4. Report violations for missing required listeners
   *
   * @param functionNode - The node to analyze (SourceFile for module-level, FunctionDeclaration for function-level)
   * @param moduleLevelOnly - If true, stop traversal at function boundaries (for module-level analysis)
   */
  analyze(functionNode: ts.Node, moduleLevelOnly = false): EventListenerCheck[] {
    const violations: EventListenerCheck[] = [];

    // Step 1: Find all instance declarations requiring event listeners
    this.findInstanceDeclarations(functionNode, moduleLevelOnly);

    // Step 2: Find all event listener attachments
    this.findEventListeners(functionNode, moduleLevelOnly);

    // Step 3: Validate all required listeners are attached
    for (const [varName, instance] of this.trackedInstances.entries()) {
      for (const requiredListener of instance.requiredListeners) {
        if (!instance.attachedEvents.has(requiredListener.event)) {
          violations.push({
            packageName: instance.packageName,
            className: instance.className,
            variableName: varName,
            missingEvent: requiredListener.event,
            requiredListener,
            declarationNode: instance.declarationNode,
          });
        }
      }
    }

    // Clear tracking for next function
    this.trackedInstances.clear();

    return violations;
  }

  /**
   * Find all instance declarations from contracts with required event listeners
   *
   * Patterns detected:
   * - const ws = new WebSocket(url)  ← Constructor pattern
   * - const queue = new Queue('tasks')  ← Constructor pattern
   * - const archive = archiver('zip')  ← Factory pattern (NEW)
   * - const socket = io(url)  ← Factory pattern (NEW)
   * - const client = createClient()  ← Factory pattern (NEW)
   * - this.client = axios.create()  ← Property assignment
   *
   * @param moduleLevelOnly - If true, stop traversal at function boundaries
   */
  private findInstanceDeclarations(node: ts.Node, moduleLevelOnly = false): void {
    const self = this;

    function visit(node: ts.Node): void {
      // If module-level only, stop at function boundaries
      if (moduleLevelOnly && self.isFunctionLike(node)) {
        return; // Don't traverse into functions
      }

      // Pattern: const ws = new WebSocket(url) OR const archive = archiver('zip')
      if (ts.isVariableDeclaration(node) && node.initializer) {
        self.checkNewExpression(node);
        self.checkFactoryMethodCall(node);
      }

      // Pattern: this.ws = new WebSocket(url) OR this.archive = archiver('zip')
      if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
        if (ts.isNewExpression(node.right)) {
          self.checkNewExpressionForAssignment(node);
        }
        if (ts.isCallExpression(node.right)) {
          self.checkFactoryMethodCallForAssignment(node);
        }
      }

      ts.forEachChild(node, visit);
    }

    visit(node);
  }

  /**
   * Check if a new expression creates an instance requiring event listeners
   */
  private checkNewExpression(declaration: ts.VariableDeclaration): void {
    if (!declaration.initializer || !ts.isNewExpression(declaration.initializer)) {
      return;
    }

    const newExpr = declaration.initializer;
    const className = this.getClassName(newExpr);
    if (!className) return;

    // Check if any contract declares this class with required event listeners
    for (const [packageName, contract] of this.contracts.entries()) {
      if (!contract.detection?.required_event_listeners) continue;
      if (!contract.detection.class_names?.includes(className)) continue;

      // This class requires event listeners - track it
      const varName = declaration.name.getText(this.sourceFile);
      this.trackedInstances.set(varName, {
        packageName,
        className,
        requiredListeners: contract.detection.required_event_listeners,
        declarationNode: declaration,
        attachedEvents: new Set(),
      });
    }
  }

  /**
   * Check assignment expressions like: this.ws = new WebSocket(url)
   */
  private checkNewExpressionForAssignment(assignment: ts.BinaryExpression): void {
    if (!ts.isNewExpression(assignment.right)) return;

    const newExpr = assignment.right;
    const className = this.getClassName(newExpr);
    if (!className) return;

    // Check if any contract declares this class with required event listeners
    for (const [packageName, contract] of this.contracts.entries()) {
      if (!contract.detection?.required_event_listeners) continue;
      if (!contract.detection.class_names?.includes(className)) continue;

      // Extract variable name from left side (e.g., "ws" from "this.ws")
      const varName = this.getVariableNameFromExpression(assignment.left);
      if (!varName) return;

      this.trackedInstances.set(varName, {
        packageName,
        className,
        requiredListeners: contract.detection.required_event_listeners,
        declarationNode: assignment,
        attachedEvents: new Set(),
      });
    }
  }

  /**
   * Extract class name from new expression
   * Examples:
   * - new WebSocket(url) → "WebSocket"
   * - new Queue('tasks') → "Queue"
   */
  private getClassName(newExpr: ts.NewExpression): string | null {
    const expr = newExpr.expression;

    if (ts.isIdentifier(expr)) {
      return expr.text;
    }

    if (ts.isPropertyAccessExpression(expr)) {
      return expr.name.text;
    }

    return null;
  }

  /**
   * Extract variable name from expression
   * Examples:
   * - this.ws → "ws"
   * - connection → "connection"
   */
  private getVariableNameFromExpression(expr: ts.Expression): string | null {
    if (ts.isIdentifier(expr)) {
      return expr.text;
    }

    if (ts.isPropertyAccessExpression(expr)) {
      return expr.name.text;
    }

    return null;
  }

  /**
   * Check if a factory method call creates an instance requiring event listeners
   *
   * Patterns:
   * - const archive = archiver('zip')
   * - const socket = io(url)
   * - const client = createClient()
   */
  private checkFactoryMethodCall(declaration: ts.VariableDeclaration): void {
    if (!declaration.initializer || !ts.isCallExpression(declaration.initializer)) {
      return;
    }

    const callExpr = declaration.initializer;
    const functionName = this.getFunctionName(callExpr);
    if (!functionName) return;

    // Check if any contract declares this factory method with required event listeners
    for (const [packageName, contract] of this.contracts.entries()) {
      if (!contract.detection?.required_event_listeners) continue;
      if (!contract.detection.factory_methods?.includes(functionName)) continue;

      // This factory method creates instances requiring event listeners - track it
      const varName = declaration.name.getText(this.sourceFile);
      this.trackedInstances.set(varName, {
        packageName,
        className: functionName,  // Use factory method name as "className"
        requiredListeners: contract.detection.required_event_listeners,
        declarationNode: declaration,
        attachedEvents: new Set(),
      });
    }
  }

  /**
   * Check factory method call in assignment: this.archive = archiver('zip')
   */
  private checkFactoryMethodCallForAssignment(assignment: ts.BinaryExpression): void {
    if (!ts.isCallExpression(assignment.right)) return;

    const callExpr = assignment.right;
    const functionName = this.getFunctionName(callExpr);
    if (!functionName) return;

    // Check if any contract declares this factory method with required event listeners
    for (const [packageName, contract] of this.contracts.entries()) {
      if (!contract.detection?.required_event_listeners) continue;
      if (!contract.detection.factory_methods?.includes(functionName)) continue;

      // Extract variable name from left side (e.g., "archive" from "this.archive")
      const varName = this.getVariableNameFromExpression(assignment.left);
      if (!varName) return;

      this.trackedInstances.set(varName, {
        packageName,
        className: functionName,  // Use factory method name as "className"
        requiredListeners: contract.detection.required_event_listeners,
        declarationNode: assignment,
        attachedEvents: new Set(),
      });
    }
  }

  /**
   * Extract function name from call expression
   *
   * Examples:
   * - archiver('zip') → "archiver"
   * - io(url) → "io"
   * - redis.createClient() → "createClient"
   */
  private getFunctionName(callExpr: ts.CallExpression): string | null {
    const expr = callExpr.expression;

    // Direct function call: archiver('zip')
    if (ts.isIdentifier(expr)) {
      return expr.text;
    }

    // Property access: redis.createClient()
    if (ts.isPropertyAccessExpression(expr)) {
      return expr.name.text;
    }

    return null;
  }

  /**
   * Find all event listener attachments
   *
   * Patterns detected:
   * - ws.on('error', handler)
   * - ws.addEventListener('error', handler)
   * - ws.once('error', handler)
   * - this.ws.on('error', handler)
   */
  private findEventListeners(node: ts.Node, moduleLevelOnly = false): void {
    const self = this;

    function visit(node: ts.Node): void {
      // If module-level only, stop at function boundaries
      if (moduleLevelOnly && self.isFunctionLike(node)) {
        return; // Don't traverse into functions
      }

      if (ts.isCallExpression(node)) {
        self.checkEventListenerCall(node);
      }
      ts.forEachChild(node, visit);
    }

    visit(node);
  }

  /**
   * Check if a call expression is attaching an event listener
   */
  private checkEventListenerCall(call: ts.CallExpression): void {
    // Must be a method call like ws.on(...)
    if (!ts.isPropertyAccessExpression(call.expression)) {
      return;
    }

    const propAccess = call.expression;
    const methodName = propAccess.name.text;

    // Only interested in event listener methods
    if (!['on', 'addEventListener', 'once'].includes(methodName)) {
      return;
    }

    // Extract variable name (e.g., "ws" from "ws.on(...)")
    const varName = this.getVariableNameFromExpression(propAccess.expression);
    if (!varName) return;

    // Check if this variable is tracked
    const instance = this.trackedInstances.get(varName);
    if (!instance) return;

    // Extract event name from first argument
    const eventName = this.getEventName(call);
    if (!eventName) return;

    // Mark this event as attached
    instance.attachedEvents.add(eventName);
  }

  /**
   * Extract event name from listener call
   * Examples:
   * - ws.on('error', handler) → "error"
   * - ws.addEventListener("message", handler) → "message"
   */
  private getEventName(call: ts.CallExpression): string | null {
    if (call.arguments.length === 0) return null;

    const firstArg = call.arguments[0];

    // String literal: 'error'
    if (ts.isStringLiteral(firstArg)) {
      return firstArg.text;
    }

    // No string literal: "message"
    if (ts.isNoSubstitutionTemplateLiteral(firstArg)) {
      return firstArg.text;
    }

    return null;
  }

  /**
   * Check if a node is a function-like construct
   * Used to stop traversal at function boundaries in module-level analysis
   */
  private isFunctionLike(node: ts.Node): boolean {
    return (
      ts.isFunctionDeclaration(node) ||
      ts.isFunctionExpression(node) ||
      ts.isArrowFunction(node) ||
      ts.isMethodDeclaration(node) ||
      ts.isConstructorDeclaration(node)
    );
  }
}
