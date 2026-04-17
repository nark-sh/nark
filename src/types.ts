/**
 * Core type definitions for behavioral contract verification
 */

export type Severity = "error" | "warning" | "info";

/**
 * Business impact annotation for a contract rule.
 * Surfaces the counterfactual to users: "here is what this violation
 * would have caused in production, and what it would have cost."
 */
export interface BusinessImpact {
  /** How this violation manifests at runtime */
  production_behavior?:
    | "silent_failure"
    | "degraded_service"
    | "immediate_exception"
    | "delayed_failure";
  /** Whether the failure is observable by the developer or user */
  visibility?: "silent" | "visible" | "catastrophic";
  /** User-facing impact when this violation triggers in production */
  user_experience?:
    | "degraded_performance"
    | "lost_data"
    | "lost_transaction"
    | "service_unavailable"
    | "security_breach"
    | "authentication_failure";
  /** Typical cost of a production incident: low <$100, medium $100-$10k, high $10k-$100k, critical >$100k */
  incident_cost_range?: "low" | "medium" | "high" | "critical";
  /** Primary business risk category shown to users in place of ERROR/WARNING */
  incident_label?:
    | "PAYMENT_RISK"
    | "DATA_LOSS"
    | "SILENT_FAILURE"
    | "DOWNTIME"
    | "SECURITY_RISK"
    | "COMPLIANCE_VIOLATION";
}

/**
 * A precondition that must be true before calling a function
 */
export interface Precondition {
  id: string;
  description: string;
  source?: string; // deprecated, use sources
  sources: string[];
  severity: Severity;
  business_impact?: BusinessImpact;
}

/**
 * A postcondition describing what happens after calling a function
 */
export interface Postcondition {
  id: string;
  condition: string;
  returns?: string;
  throws?: string;
  required_handling?: string;
  source?: string; // deprecated, use sources
  sources: string[];
  severity: Severity;
  /**
   * Patterns that satisfy this postcondition, suppressing violations.
   * Used when specific catch patterns (e.g., instanceof checks) are sufficient.
   */
  satisfying_patterns?: SatisfyingPattern[];
  business_impact?: BusinessImpact;
}

/**
 * An edge case documenting surprising but not incorrect behavior
 */
export interface EdgeCase {
  id: string;
  description: string;
  source?: string; // deprecated, use sources
  sources: string[];
  severity: "warning" | "info";
  business_impact?: BusinessImpact;
}

/**
 * A function contract specifying behavioral expectations
 */
export interface FunctionContract {
  name: string;
  import_path: string;
  description: string;
  namespace?: string; // For namespace methods like ts.sys.readFile() where namespace="sys"
  /** Alternative function names that map to the same contract (e.g. tar.x → extract, tar.c → create) */
  aliases?: string[];
  preconditions?: Precondition[];
  postconditions?: Postcondition[];
  edge_cases?: EdgeCase[];
}

/**
 * Required event listener configuration
 */
export interface RequiredEventListener {
  /** Event name (e.g., "error", "failed") */
  event: string;
  /** Whether this listener is required */
  required: boolean;
  /** Severity if missing (error, warning, info) */
  severity?: "error" | "warning" | "info";
}

/**
 * A pattern that satisfies a postcondition, allowing it to be suppressed.
 * Used for postconditions where the specific error handling pattern is sufficient.
 */
export interface SatisfyingPattern {
  /** instanceof check in a catch block that satisfies this postcondition,
   *  e.g. "Stripe.errors.StripeRateLimitError" */
  instanceof?: string;
}

/**
 * Detection rules for identifying package usage in code
 */
export interface DetectionRules {
  /** Class names used for instantiation (e.g., ["Octokit", "PrismaClient"]) */
  class_names?: string[];
  /** TypeScript type names used in declarations (e.g., ["Octokit", "AxiosInstance"]) */
  type_names?: string[];
  /** Factory method names (e.g., ["createClient", "create"]) */
  factory_methods?: string[];
  /** Patterns to match in await expressions (e.g., [".repos.", ".pulls."]) */
  await_patterns?: string[];
  /**
   * If true, ONLY detect violations on tracked instances (no pattern fallback)
   * Use this for packages with generic method names (mongoose, Prisma, TypeORM)
   * to eliminate false positives from pattern matching
   */
  require_instance_tracking?: boolean;
  /** Required event listeners for event-emitting classes */
  required_event_listeners?: RequiredEventListener[];
  /**
   * If true, only flag violations when the function call is awaited.
   * Use for testing-framework hook functions (mocha: it/before/after/describe)
   * where synchronous calls are valid and only async rejections matter.
   */
  require_await_detection?: boolean;
  /**
   * If set, only detect violations when the class/factory is imported from this
   * exact package specifier. Prevents false positives when multiple packages
   * export identically-named classes (e.g., ioredis vs @upstash/redis both export Redis).
   */
  import_source?: string;
  /**
   * Methods on a tracked instance that return another instance of the same package.
   * When `result = await trackedVar.method()` or `result = trackedVar.method()`, `result` is also tracked.
   * Use for package APIs where one instance creates sub-instances (e.g., pdfjs-dist: doc.getPage() → page).
   * Example: ["getPage", "render"]
   */
  instance_chain_methods?: string[];
  /**
   * Factory functions whose return value has a `.promise` property to await.
   * When `result = await factory().promise`, track `result` as the same package.
   * Use for packages like pdfjs-dist where getDocument() returns a task with a .promise.
   * Example: ["getDocument"]
   */
  promise_factory_methods?: string[];
  /**
   * Maps property names on tracked instances to the function contract to use for violation detection.
   * When `await trackedInstance.propertyName` is used without try-catch, fire a violation attributed
   * to `functionName` in the package contract.
   * Use for packages where the async result is accessed as a property, not a method call
   * (e.g., pdfjs-dist: `await renderTask.promise` → attributed to the `render` function contract).
   * Example: { "promise": "render" }
   */
  awaitable_properties?: Record<string, string>;
}

/**
 * A complete package contract
 */
export interface PackageContract {
  package: string;
  semver: string;
  contract_version: string;
  maintainer: string;
  last_verified: string;
  /** Quality/validation status (production, draft, in-development, deprecated) */
  status?: "production" | "draft" | "in-development" | "deprecated";
  deprecated?: boolean;
  deprecated_reason?: string;
  deprecated_date?: string;
  /** Detection rules for analyzer integration */
  detection?: DetectionRules;
  functions: FunctionContract[];
}

/**
 * A violation found in user code
 */
export interface Violation {
  id: string;
  severity: Severity;
  file: string;
  line: number;
  column: number;
  package: string;
  function: string;
  contract_clause: string;
  description: string;
  source_doc: string;
  suggested_fix?: string;
  /** Business impact from the contract rule — used to surface counterfactual value to users */
  business_impact?: BusinessImpact;
  /** Additional postconditions violated at the same call site — lets the developer/AI write a complete fix upfront. */
  subViolations?: Array<{
    postconditionId: string;
    description: string;
    severity: "error" | "warning";
    business_impact?: BusinessImpact;
  }>;
  code_snippet?: {
    startLine: number;
    endLine: number;
    lines: Array<{ line: number; content: string; highlighted: boolean }>;
  };
}

/**
 * Summary statistics for a verification run
 */
export interface VerificationSummary {
  total_violations: number;
  error_count: number;
  warning_count: number;
  info_count: number;
  files_analyzed: number;
  passed: boolean;
}

/**
 * Complete audit record produced by a verification run
 */
export interface AuditRecord {
  tool: string;
  tool_version: string;
  corpus_version: string;
  timestamp: string;
  git_commit?: string;
  git_branch?: string;
  git_dirty?: boolean;
  tsconfig: string;
  packages_analyzed: string[];
  contracts_applied: number;
  callsites_by_package?: Record<string, number>;
  files_analyzed: number;
  violations: Violation[];
  summary: VerificationSummary;
}

/**
 * Location of a function call in the AST
 */
export interface CallSite {
  file: string;
  line: number;
  column: number;
  functionName: string;
  packageName: string;
}

/**
 * Result of analyzing a single call site
 */
export interface CallSiteAnalysis {
  callSite: CallSite;
  hasTryCatch: boolean;
  hasPromiseCatch: boolean;
  checksResponseExists: boolean;
  checksStatusCode: boolean;
  handledStatusCodes: number[];
  hasRetryLogic: boolean;
}

/**
 * Configuration options for the analyzer
 */
export interface AnalyzerConfig {
  tsconfigPath: string;
  corpusPath: string;
  includePaths?: string[];
  excludePaths?: string[];
  severityThreshold?: Severity;
  /** Whether to include test files in analysis (default: false) */
  includeTests?: boolean;
}

/**
 * Result of loading the corpus
 */
export interface CorpusLoadResult {
  contracts: Map<string, PackageContract>;
  errors: string[];
  skipped?: Array<{ package: string; status: string; reason: string }>;
  contractFiles?: Map<string, string[]>; // packageName -> absolute file paths loaded
}

/**
 * A package discovered in the project
 */
export interface DiscoveredPackage {
  name: string;
  version: string;
  source: "package.json" | "import" | "both";
  hasContract: boolean;
  contractVersion?: string;
  usedIn: string[]; // Files where the package is imported
  callSiteCount: number; // Number of call expressions using this package
}

/**
 * Result of package discovery scan
 */
export interface PackageDiscoveryResult {
  total: number;
  withContracts: number;
  withoutContracts: number;
  packages: DiscoveredPackage[];
}

/**
 * Enhanced audit record with package discovery
 */
export interface EnhancedAuditRecord extends AuditRecord {
  package_discovery: PackageDiscoveryResult;
  violations_by_package: Record<
    string,
    {
      total: number;
      errors: number;
      warnings: number;
      info: number;
      violations: Violation[];
    }
  >;
}

/**
 * A positive pattern (best practice) detected in code
 */
export interface PositivePattern {
  id: string;
  name: string;
  description: string;
  file: string;
  line: number;
  column: number;
  category: "configuration" | "error-handling" | "performance" | "consistency";
  benefit: string;
  code_snippet?: {
    startLine: number;
    endLine: number;
    lines: Array<{ line: number; content: string; highlighted: boolean }>;
  };
}

/**
 * React Query hook call detection
 */
export interface HookCall {
  hookName: "useQuery" | "useMutation" | "useInfiniteQuery" | "QueryClient";
  location: {
    file: string;
    line: number;
    column: number;
  };
  returnValues: Map<string, string>; // variableName -> property (error, isError, data, etc.)
  options: {
    onError?: boolean;
    onMutate?: boolean;
    onSuccess?: boolean;
    retry?: "default" | "number" | "boolean" | "function";
  };
}

/**
 * Variable usage tracking for hook return values
 */
export interface VariableUsage {
  variableName: string;
  propertyName: string; // 'error', 'isError', 'data', etc.
  declaredAt: {
    file: string;
    line: number;
  };
  usedIn: {
    conditionals: number; // Count of if/ternary checks
    jsxExpressions: number; // Count of JSX usage
    callbacks: number; // Count of callback usage
  };
}

/**
 * Analysis of error handling in React Query hooks
 */
export interface HookErrorHandling {
  hasErrorStateCheck: boolean; // Checks isError or error
  hasOnErrorCallback: boolean; // Has onError in options
  hasGlobalHandler: boolean; // QueryCache/MutationCache configured
  errorCheckedBeforeDataAccess: boolean; // Proper order
  hasOptimisticUpdateRollback?: boolean; // For mutations with onMutate
  retryAnalysis?: {
    type: "default" | "number" | "boolean" | "function";
    avoidsClientErrors: boolean; // Checks for 4xx before retrying
  };
}
