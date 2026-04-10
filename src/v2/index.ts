/**
 * Universal Analyzer v2 - Public API
 *
 * Export all public types and classes.
 */

// Main analyzer
export { UniversalAnalyzer } from './analyzer.js';

// Core components
export { TraversalEngine } from './core/traversal-engine.js';
export { ImportTracker } from './core/import-tracker.js';
export { ControlFlowAnalysis } from './core/control-flow-analyzer.js';
export { ContractMatcher } from './core/contract-matcher.js';

// Detector plugins
export { ThrowingFunctionDetector } from './plugins/throwing-function-detector.js';
export { PropertyChainDetector } from './plugins/property-chain-detector.js';
export { EventListenerDetector } from './plugins/event-listener-detector.js';
export { CallbackDetector } from './plugins/callback-detector.js';
export { ReturnValueChecker } from './plugins/return-value-checker.js';
export { InstanceTrackerPlugin } from './plugins/instance-tracker.js';

// Adapter (v2 → v1 bridge)
export { runV2Analyzer } from './adapter.js';
export type { V2AdapterResult } from './adapter.js';

// Types
export * from './types/index.js';
