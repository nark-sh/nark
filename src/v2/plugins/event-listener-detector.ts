/**
 * Event Listener Detector Plugin
 *
 * Detects event listener registrations that may receive error events.
 * This pattern covers ~8% of contracts.
 *
 * Examples:
 *   - ws.on('error', handler)
 *   - archive.on('error', handler)
 *   - queue.on('failed', handler)
 *   - emitter.addEventListener('error', handler)
 */

import * as ts from 'typescript';
import { DetectorPlugin, PluginContext, NodeContext, Detection } from '../types/index.js';

/**
 * Event Listener Detector
 *
 * Detects calls to event registration methods (.on, .once, .addEventListener, etc.)
 */
export class EventListenerDetector implements DetectorPlugin {
  name = 'EventListenerDetector';
  version = '1.0.0';
  description = 'Detects event listener registration methods';

  // Event registration method names
  private readonly eventMethods = new Set([
    'on',
    'once',
    'addEventListener',
    'addListener',
    'prependListener',
    'prependOnceListener',
  ]);

  // Track instance variables (same as PropertyChainDetector)
  private instanceMap = new Map<string, string>();

  /**
   * Initialize plugin
   */
  public initialize(_context: PluginContext): void {
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
   */
  public onVariableDeclaration(node: ts.VariableDeclaration, context: NodeContext): Detection[] {
    if (node.initializer && ts.isNewExpression(node.initializer)) {
      const newExpr = node.initializer;

      if (ts.isIdentifier(newExpr.expression)) {
        const className = newExpr.expression.text;
        const importInfo = context.importMap.get(className);

        if (importInfo) {
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
   * Look for: obj.on('event', handler), obj.addEventListener('event', handler)
   */
  public onCallExpression(node: ts.CallExpression, context: NodeContext): Detection[] {
    const funcExpr = node.expression;

    // Must be a property access (obj.method)
    if (!ts.isPropertyAccessExpression(funcExpr)) {
      return [];
    }

    // Check if method name is an event registration method
    const methodName = funcExpr.name.text;
    if (!this.eventMethods.has(methodName)) {
      return [];
    }

    // Get event name (first argument)
    const eventName = this.getEventName(node.arguments[0]);
    if (!eventName) {
      return []; // No event name, skip
    }

    // Get the object being called
    const object = funcExpr.expression;

    // Determine package name
    let packageName: string | null = null;

    // Case 1: Direct import (ws.on)
    if (ts.isIdentifier(object)) {
      const importInfo = context.importMap.get(object.text);
      if (importInfo) {
        packageName = importInfo.packageName;
      } else {
        // Check instance map
        packageName = this.instanceMap.get(object.text) || null;
      }
    }

    // Case 2: Property chain (server.ws.on) - get root
    if (ts.isPropertyAccessExpression(object)) {
      const root = this.getRoot(object);
      if (root) {
        const importInfo = context.importMap.get(root);
        if (importInfo) {
          packageName = importInfo.packageName;
        } else {
          packageName = this.instanceMap.get(root) || null;
        }
      }
    }

    // Skip if we can't determine package
    if (!packageName) {
      return [];
    }

    // Build function name: "on:event" or "addEventListener:event"
    const functionName = `${methodName}:${eventName}`;

    return [
      {
        pluginName: this.name,
        pattern: 'event-listener',
        node,
        packageName,
        functionName,
        confidence: 'high',
        metadata: {
          method: methodName,
          event: eventName,
        },
      },
    ];
  }

  /**
   * Extract event name from first argument
   *
   * Handles: .on('error'), .on("error"), .on(`error`)
   */
  private getEventName(arg: ts.Expression | undefined): string | null {
    if (!arg) {
      return null;
    }

    if (ts.isStringLiteral(arg)) {
      return arg.text;
    }

    if (ts.isNoSubstitutionTemplateLiteral(arg)) {
      return arg.text;
    }

    // Could also handle identifiers (const EVENT_NAME = 'error'; .on(EVENT_NAME))
    // but that requires more complex analysis

    return null;
  }

  /**
   * Get root identifier from property chain
   *
   * Example: server.ws.connection -> 'server'
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
