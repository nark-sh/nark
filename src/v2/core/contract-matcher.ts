/**
 * Contract Matcher
 *
 * Matches Detection[] → Violation[] by consulting the contract corpus.
 * For each detection, finds the matching package contract and postcondition,
 * checks if the call is in a try-catch, and generates violations accordingly.
 */

import * as ts from "typescript";
import * as path from "path";
import type {
  PackageContract,
  Postcondition,
  FunctionContract,
} from "../../types.js";
import type {
  Detection,
  Violation,
  PassedDetection,
} from "../types/index.js";
import { ControlFlowAnalysis } from "./control-flow-analyzer.js";
import { checkSuppression } from "../../suppressions/matcher.js";
import { computeViolationFingerprint } from "../../suppressions/fingerprint.js";
import { loadWrapperConfigSync } from "../../suppressions/wrapper-config.js";
import { DetectionTraceAccumulator } from "./detection-trace-accumulator.js";
import { MATCHER_IDS } from "../matchers/registry.js";

export interface ContractMatcherOptions {
  projectRoot: string;
  analyzerVersion?: string;
  /** TypeScript program for project-wide scans (e.g., ClerkProvider detection) */
  program?: ts.Program;
}

/**
 * §10: knex postconditions that get suppressed when the callsite is in a Model-layer
 * file AND the project has a central errorHandler middleware. These are the per-callsite
 * error-throw postconditions (the ones a try-catch around the call would address). Logic
 * checks (zero-rows-not-checked), security checks (sql-injection-risk), lifecycle checks
 * (not-called-on-shutdown), and migration postconditions are intentionally NOT gated —
 * they remain meaningful regardless of project-level error handling.
 */
const SECTION_10_KNEX_GATED_POSTCONDITIONS = new Set([
  "select-query-error",
  "insert-constraint-violation",
  "update-no-try-catch",
  "delete-no-try-catch",
  "delete-foreign-key-violation",
  "first-no-try-catch",
  "raw-no-try-catch",
  "destroy-no-try-catch",
  "batch-insert-no-try-catch",
  "transaction-error",
  "increment-no-try-catch",
  "decrement-no-try-catch",
  "transaction-provider-factory-no-try-catch",
  "schema-create-table-no-try-catch",
]);

/**
 * §10 Phase 2: typeorm postconditions that get suppressed when the callsite is in a
 * data-layer file (Model OR Repository naming) AND the project has a central errorHandler
 * middleware. Same architectural pattern as the knex Phase 1 ship: Controller -> Service ->
 * Repository -> typeorm. Per-callsite error-throw checks are gated; logic checks
 * (update-silent-no-op, delete-silent-no-op, softdelete-silent-no-op), security checks
 * (query-sql-injection-risk), and lifecycle checks (initialize-*, destroy-*,
 * optimistic-locking-version-mismatch, datasource-initialization) are intentionally NOT
 * gated — they remain meaningful regardless of project-level error handling.
 *
 * Evidence: rsschool-app server scan (2026-05-18) — 28 typeorm violations in
 * `*.repository.ts` files plus 50 in `/routes/`-mounted handlers, all routed through
 * Koa's central errorHandlerMiddleware at server/src/routes/logging.ts:13.
 */
const SECTION_10_TYPEORM_GATED_POSTCONDITIONS = new Set([
  "find-query-error",
  "save-constraint-violation",
  "transaction-error",
  "findone-query-failed-error",
  "findoneby-query-failed-error",
  "findone-or-fail-entity-not-found",
  "findone-or-fail-query-failed",
  "findonebyorfail-entity-not-found",
  "insert-duplicate-key-error",
  "insert-foreign-key-violation",
  "update-constraint-violation",
  "delete-foreign-key-constraint",
  "upsert-constraint-violation",
  "query-sql-syntax-error",
  "softdelete-missing-delete-date-column",
  "restore-missing-delete-date-column",
  "remove-foreign-key-constraint",
  "count-query-failed-error",
  "findby-query-failed-error",
  "findandcount-query-failed-error",
  "increment-type-mismatch",
  "decrement-type-mismatch",
]);

/**
 * Contract Matcher
 *
 * Converts detections to violations by matching against loaded contracts.
 */
export class ContractMatcher {
  private contracts: Map<string, PackageContract>;
  private options: ContractMatcherOptions;
  private controlFlow: ControlFlowAnalysis;
  /** Cached result of Clerk middleware configuration check (null = not yet checked) */
  private clerkMiddlewareConfigured: boolean | null = null;
  /** Cached result of ClerkProvider project-wide presence check (null = not yet checked) */
  private clerkProviderPresent: boolean | null = null;
  /** Cached result of project-wide React Query global error handler check (null = not yet checked) */
  private reactQueryGlobalErrorHandler: boolean | null = null;
  /** Cached result of project-wide central error handler middleware check (null = not yet checked) */
  private centralErrorHandlerMiddleware: boolean | null = null;
  /** Tracks real call site evaluations per package (pass + fail) */
  private _callSitesByPackage: Map<string, number> = new Map();
  /**
   * Buffer of passing-site records captured during the LAST matchDetections
   * call. Reset at the top of each matchDetections invocation. The analyzer
   * reads this immediately after calling matchDetections() via
   * getLastPassedDetections() and attaches it to FileAnalysisResult.
   *
   * Wave 2 (this and Plans 01-04..01-08): contract-matcher guards push to
   * this buffer when a protection matcher causes a `continue`. Wave 9
   * (Plan 01-09) reads the aggregated array via the per-file results.
   *
   * IN-MEMORY ONLY — NEVER serialized to public Violation JSON, SARIF, or
   * telemetry. The audit-record path in src/reporter.ts only reads
   * Violation fields, so this buffer never leaks through.
   */
  private _lastPassedDetections: PassedDetection[] = [];
  /**
   * Cached project-level `.nark/suppress.yaml` callback_wrappers extension list
   * (null = not yet checked). Used to extend the built-in wrapper-name pattern
   * list per-project.
   * Evidence: concern-20260515-section8-promisecall-promisestate-wrapper-shells.
   */
  private extraCallbackWrappers: string[] | null = null;
  constructor(
    contracts: Map<string, PackageContract>,
    options: ContractMatcherOptions,
  ) {
    this.contracts = contracts;
    this.options = options;
    this.controlFlow = new ControlFlowAnalysis();
  }

  /**
   * Get the real call site counts per package (includes both passing and failing evaluations).
   */
  public get callSitesByPackage(): Record<string, number> {
    return Object.fromEntries(this._callSitesByPackage);
  }

  /**
   * Return the PassedDetection[] buffer captured during the most recent
   * matchDetections() call. The analyzer reads this and attaches it to
   * FileAnalysisResult.passedDetections so Wave 9 (convention-miner) can
   * walk it project-wide.
   *
   * Returns a fresh array (caller may not mutate the internal buffer).
   * Returns `[]` when no passing-site record was pushed (e.g. file had no
   * detections, or every guard fell through to fire a violation, or Wave
   * 2 rewiring has not yet covered the package family that fired the
   * continue).
   *
   * IN-MEMORY ONLY — the analyzer wires this to FileAnalysisResult, never
   * to the audit JSON.
   */
  public getLastPassedDetections(): PassedDetection[] {
    return this._lastPassedDetections.slice();
  }

  /**
   * WAVE-2B (Plan 01-04) helper, renamed in WAVE-2C (Plan 01-05) from
   * `recordFrameworkPassedSite` → `recordPassedSite` because the buffer now
   * captures DB-driver and architectural passing sites too — not just
   * framework families. Behavior unchanged; only the name and the gate set
   * (PASSING_SITE_PACKAGES, formerly FRAMEWORK_PACKAGES) widened.
   *
   * Captures a passing site into _lastPassedDetections so the Wave 9
   * convention-miner can read it. Gated by ContractMatcher.PASSING_SITE_PACKAGES
   * — only the families that Plans 01-04..01-08 have explicitly wired
   * participate. Plans 01-06..01-08 widen the set with AWS SDK / lifecycle /
   * long-tail packages.
   *
   * Centralized to avoid repeating the gate + getLocation + push triplet at
   * each of the ~17+ suppression branches in matchDetections.
   */
  private recordPassedSite(
    detection: Detection,
    sourceFile: ts.SourceFile,
    postconditionId: string,
    passedMatcherId: string,
  ): void {
    if (!ContractMatcher.PASSING_SITE_PACKAGES.has(detection.packageName)) {
      return;
    }
    const { line } = this.getLocation(detection.node, sourceFile);
    this._lastPassedDetections.push({
      packageName: detection.packageName,
      postconditionId,
      file: sourceFile.fileName,
      line,
      passedMatcherId,
    });
  }

  // WAVE-2D: AWS SDK family-to-matcher routing helper.
  /**
   * WAVE-2D (Plan 01-06) helper: returns the canonical AWS_* MATCHER_IDS
   * entry for an @aws-sdk/* package, or null when the package isn't an
   * AWS SDK family. Used at the canonical OR-chain (line ~2380) to attach
   * the per-command-family matcher record alongside the standard
   * try-catch:direct / promise:catch-handler / options:on-error /
   * destructured-error:tuple records.
   *
   * Package families collapsed into a single matcher when their command-
   * shape semantics are equivalent (e.g. lib-storage and s3-request-presigner
   * both map to aws:s3-command because Upload() and getSignedUrl() are S3
   * operations even though they live in companion packages).
   */
  private static awsCommandMatcherIdFor(packageName: string): string | null {
    switch (packageName) {
      case "@aws-sdk/client-s3":
        return MATCHER_IDS.AWS_S3_COMMAND;
      case "@aws-sdk/client-ses":
        return MATCHER_IDS.AWS_SES_COMMAND;
      case "@aws-sdk/client-sesv2":
        return MATCHER_IDS.AWS_SESV2_COMMAND;
      case "@aws-sdk/client-sqs":
        return MATCHER_IDS.AWS_SQS_COMMAND;
      case "@aws-sdk/client-sns":
        return MATCHER_IDS.AWS_SNS_COMMAND;
      case "@aws-sdk/client-dynamodb":
        return MATCHER_IDS.AWS_DYNAMODB_COMMAND;
      case "@aws-sdk/client-secrets-manager":
        return MATCHER_IDS.AWS_SECRETS_MANAGER_COMMAND;
      case "@aws-sdk/client-bedrock-runtime":
        return MATCHER_IDS.AWS_BEDROCK_INVOKE;
      case "@aws-sdk/client-lambda":
        return MATCHER_IDS.AWS_LAMBDA_INVOKE;
      case "@aws-sdk/client-cloudwatch-logs":
        return MATCHER_IDS.AWS_CLOUDWATCH_LOG_EVENT;
      case "@aws-sdk/lib-storage":
        return MATCHER_IDS.AWS_LIB_STORAGE_UPLOAD;
      case "@aws-sdk/s3-request-presigner":
        return MATCHER_IDS.AWS_S3_PRESIGNER;
      default:
        return null;
    }
  }

  // WAVE-2D: AWS command-class extraction from detection AST.
  /**
   * WAVE-2D (Plan 01-06) helper: extract the AWS command class name from the
   * first argument of a send()-shaped call. Returns the command class string
   * (e.g. "GetObjectCommand", "SendEmailCommand") when the first argument is
   * a `new CommandClass(...)` NewExpression, or null when the command shape
   * cannot be statically determined (variable argument, no arguments, or
   * non-NewExpression). Mirrors the shape used by pickS3SendPostcondition
   * et al. (lines ~3700+), but returns the raw class name rather than a
   * postcondition lookup — the convention miner consumes the class name
   * directly via the `aws:<family>:<CommandClass>` suffixed matcher record.
   *
   * For lib-storage Upload (new Upload({...}).done()) and s3-request-presigner
   * getSignedUrl(client, command, opts), the function inspection rules differ:
   *  - lib-storage Upload: the detection node is the .done() call; we walk up
   *    one level to find the new Upload() and synthesize "Upload" as the class.
   *  - s3-request-presigner getSignedUrl: the second argument is the command
   *    NewExpression; first argument is the client.
   * Both fall back to null when the AST doesn't match, which is fine — the
   * base aws:<family> matcher still records without the command suffix.
   */
  private extractAwsCommandClass(detection: Detection): string | null {
    if (!ts.isCallExpression(detection.node)) return null;
    const args = detection.node.arguments;

    // s3-request-presigner.getSignedUrl(client, command, opts): inspect arg[1]
    if (
      detection.packageName === "@aws-sdk/s3-request-presigner" &&
      detection.functionName === "getSignedUrl" &&
      args.length >= 2
    ) {
      const cmdArg = args[1];
      if (ts.isNewExpression(cmdArg) && ts.isIdentifier(cmdArg.expression)) {
        return cmdArg.expression.text;
      }
      return null;
    }

    // lib-storage Upload: detection is the .done() call on a `new Upload()`
    // instance. The instance-tracker resolves these as packageName=
    // "@aws-sdk/lib-storage", functionName="done". The command-class is
    // synthetically "Upload" since lib-storage has only one operation shape.
    if (
      detection.packageName === "@aws-sdk/lib-storage" &&
      detection.functionName === "done"
    ) {
      return "Upload";
    }

    // bedrock-runtime invokeModel / invokeModelWithResponseStream / converse /
    // converseStream — the detection.functionName already names the operation;
    // there's no command-class wrapper in the modern bedrock API. Use the
    // functionName as the synthetic command class so the miner can group by
    // operation (e.g. aws:bedrock-invoke:invokeModel vs converse).
    if (detection.packageName === "@aws-sdk/client-bedrock-runtime") {
      if (
        detection.functionName === "invokeModel" ||
        detection.functionName === "invokeModelWithResponseStream" ||
        detection.functionName === "converse" ||
        detection.functionName === "converseStream"
      ) {
        return detection.functionName;
      }
    }

    // lambda Invoke: traditional client.send(new InvokeCommand({...})) path
    // falls through to the generic send() inspection below. Fall through.

    // Generic send(new CommandClass({...})) — applies to client-s3, ses,
    // sesv2, sqs, sns, dynamodb, secrets-manager, lambda, cloudwatch-logs.
    if (detection.functionName === "send" && args.length >= 1) {
      const firstArg = args[0];
      if (
        ts.isNewExpression(firstArg) &&
        ts.isIdentifier(firstArg.expression)
      ) {
        return firstArg.expression.text;
      }
    }

    return null;
  }

  /**
   * Match a set of detections against contracts and produce violations.
   */
  public matchDetections(
    detections: Detection[],
    sourceFile: ts.SourceFile,
  ): Violation[] {
    const violations: Violation[] = [];
    // Reset the passing-site buffer at the top of each call. The previous
    // file's passing sites have already been consumed by the analyzer via
    // getLastPassedDetections().
    this._lastPassedDetections = [];

    // WAVE-2F (Plan 01-08) — INTENTIONALLY UNREWIRED loop-control plumbing.
    //
    // The next ~9 `continue;` statements below (up to and including the
    // postconditions-empty / return-value-pattern gates around line ~540) are
    // pre-trace loop-control plumbing. They cannot be rewired with
    // `trace.record(...)` because the DetectionTraceAccumulator (`trace`) is
    // instantiated AFTER the postcondition selection at line ~570 — neither
    // `packageName + postconditionId` context nor the accumulator itself
    // exists yet.
    //
    // These continues handle:
    //   1. missing-event-listener pattern routing (handled by separate plugin)
    //   2. event-listener presence skip (handled by absence plugin)
    //   3. decorator call skip (@Controller, @Injectable — not real call sites)
    //   4. no matching contract for this package
    //   5. require_await_detection: skip non-awaited calls
    //   6. NextResponse.redirect() name-collision skip (NOT next/navigation)
    //   7. no matching function contract (after default-import fallback)
    //   8. zero throwing postconditions for this contract function
    //   9. return-value-pattern skip (covered by throwing-function/property-chain)
    //
    // Each represents a "this detection should not produce a violation"
    // signal that pre-dates postcondition selection. Wave 9 (convention
    // mining) cannot consume these signals anyway — there is no violation
    // and no postcondition to attach a convention to. Documented here so
    // the grep audit (`continue;` count vs `trace.record` count) doesn't
    // mistake these for missing rewires.
    for (const detection of detections) {
      // Handle missing-event-listener absence detection
      if (detection.pattern === "missing-event-listener") {
        const violation = this.handleMissingEventListener(
          detection,
          sourceFile,
        );
        if (violation) violations.push(violation);
        continue;
      }

      // Handle Bedrock stream chunk error field absence detection
      if (detection.pattern === "bedrock-stream-chunk-missing") {
        const violation = this.handleBedrockStreamChunkMissing(
          detection,
          sourceFile,
        );
        if (violation) violations.push(violation);
        continue;
      }

      // Skip presence-based event-listener detections (handled by absence plugin)
      if (detection.pattern === "event-listener") {
        continue;
      }

      // Skip call expressions used as decorators (e.g., @Controller(), @Injectable()).
      // Decorator calls are not real call sites that need error handling — the parent
      // node is a Decorator when the CallExpression is used in decorator position.
      if (
        ts.isCallExpression(detection.node) &&
        detection.node.parent &&
        ts.isDecorator(detection.node.parent)
      ) {
        continue;
      }

      // Find matching contract
      const contract = this.contracts.get(detection.packageName);
      if (!contract) {
        continue;
      }

      // For packages requiring await: skip non-awaited calls (e.g., mocha hook functions)
      if (contract.detection?.require_await_detection) {
        const isAwaited = ts.isAwaitExpression(detection.node.parent);
        if (!isAwaited) {
          continue;
        }
      }

      // Find matching function contract.
      // For property-chain detections, prefer a chainStr-specific match over the generic
      // functionName match (e.g., prefer "embeddings.create" over "create" for
      // openai.embeddings.create() calls). This ensures package-namespaced functions
      // like openai.embeddings.create() use the correct postconditions.
      // For throwing-function detections that carry instanceTypeName (e.g., channel: GuildChannel),
      // use the type name as a class-prefix hint to disambiguate dotted-name contracts
      // (e.g., GuildChannel.delete vs Message.delete when functionName='delete').
      const chainStr =
        detection.pattern === "property-chain"
          ? (detection.metadata?.chainStr as string | undefined)
          : (detection.metadata?.instanceTypeName as string | undefined);
      // superagent: agent instance rerouting.
      // When superagent.agent() is called and the result is stored (e.g., `const agent = superagent.agent()`),
      // the instance-tracker resolves `agent.get()` as packageName='superagent', functionName='get'.
      // However, calls on a superagent Agent instance should match the `agent` function contract
      // (postconditions: agent-request-network-error, agent-session-auth-failure) rather than
      // the raw `get` function contract — because agent instances carry session state and the
      // error profile is subtly different (auth expiry, cookie persistence).
      //
      // Detection: the metadata.chain is ['agent', 'get'] for agent.get() but ['superagent', 'get']
      // for superagent.get(). When chain[0] !== 'superagent' (i.e., it's a variable, not the import),
      // we're on an agent instance.
      let effectiveFunctionName = detection.functionName;
      if (
        detection.packageName === "superagent" &&
        ["get", "post", "put", "patch", "delete", "del", "head"].includes(detection.functionName) &&
        Array.isArray(detection.metadata?.chain) &&
        (detection.metadata.chain as string[])[0] !== "superagent"
      ) {
        // This is a call on a superagent agent instance — use the `agent` function's postconditions
        effectiveFunctionName = "agent";
      }

      // xml2js: Parser instance rerouting.
      // When a Parser instance calls parseStringPromise(), the ThrowingFunctionDetector resolves
      // the call as packageName='xml2js', functionName='parseStringPromise'. The exact-match
      // findFunctionContract would return the module-level parseStringPromise entry (postcondition:
      // parse-error-malformed-xml). But Parser instances have their own contract entry:
      // Parser.parseStringPromise (postcondition: parser-instance-malformed-xml).
      //
      // Detection: metadata.chain is ['parser', 'parseStringPromise'] for parser.parseStringPromise()
      // and ['xml2js', 'parseStringPromise'] or ['parseStringPromise'] for module-level calls.
      // When chain[0] is not the xml2js import name and not the function name itself (i.e., it's a
      // variable holding a Parser instance), reroute to Parser.parseStringPromise.
      //
      // Evidence: concern-20260417-xml2js-deepen-3 ground-truth test (line 148: parser.parseStringPromise
      // should fire parser-instance-malformed-xml, not the module-level parse-error-malformed-xml).
      if (
        detection.packageName === "xml2js" &&
        detection.functionName === "parseStringPromise" &&
        Array.isArray(detection.metadata?.chain) &&
        (detection.metadata.chain as string[])[0] !== "xml2js" &&
        (detection.metadata.chain as string[])[0] !== "parseStringPromise"
      ) {
        // Call is on a Parser instance variable — use Parser.parseStringPromise entry
        effectiveFunctionName = "Parser.parseStringPromise";
      }

      // xml2js: Parser instance rerouting for parseString() (callback form).
      // When a Parser instance calls parseString(), the ThrowingFunctionDetector resolves
      // the call as packageName='xml2js', functionName='parseString'. The exact-match
      // findFunctionContract returns the module-level parseString entry (postconditions:
      // parse-string-callback-error-ignored, parse-string-no-callback). But Parser instances
      // have their own contract entry: Parser.parseString (postconditions:
      // parser-instance-parse-string-callback-error-ignored, parser-instance-parse-string-no-callback).
      //
      // Detection: metadata.chain is ['parser', 'parseString'] for parser.parseString()
      // and ['xml2js', 'parseString'] or ['parseString'] for module-level calls.
      // When chain[0] is not the xml2js import name and not the function name itself (i.e., it's a
      // variable holding a Parser instance), reroute to Parser.parseString.
      //
      // Evidence: concern-20260630-xml2js-instance-disambiguation-1 — scanner was firing
      // parse-string-callback-error-ignored (module-level) instead of
      // parser-instance-parse-string-callback-error-ignored for parser.parseString() calls.
      if (
        detection.packageName === "xml2js" &&
        detection.functionName === "parseString" &&
        Array.isArray(detection.metadata?.chain) &&
        (detection.metadata.chain as string[])[0] !== "xml2js" &&
        (detection.metadata.chain as string[])[0] !== "parseString"
      ) {
        // Call is on a Parser instance variable — use Parser.parseString entry
        effectiveFunctionName = "Parser.parseString";
      }

      // luxon: Duration.fromObject disambiguation.
      // Both DateTime.fromObject and Duration.fromObject share the same method name 'fromObject'.
      // ThrowingFunctionDetector resolves these as functionName='fromObject' with metadata.chain
      // containing the root identifier (['Duration', 'fromObject'] or ['DateTime', 'fromObject']).
      // findFunctionContract's dotted-name suffix match finds both entries and returns the first
      // (DateTime.fromObject), causing Duration.fromObject() calls to fire the wrong postcondition.
      //
      // Fix: when chain root is 'Duration', reroute to 'Duration.fromObject' so findFunctionContract
      // exact-matches the correct entry (duration-fromobject-non-object-throws) instead of
      // returning fromobject-conflicting-specification from DateTime.fromObject.
      //
      // Evidence: concern luxon-deepen-3; ground-truth fixture line 334.
      if (
        detection.packageName === "luxon" &&
        detection.functionName === "fromObject" &&
        Array.isArray(detection.metadata?.chain) &&
        (detection.metadata.chain as string[])[0] === "Duration"
      ) {
        effectiveFunctionName = "Duration.fromObject";
      }

      // luxon: fromMillis / fromSeconds — suppress when argument is already a numeric expression.
      //
      // The postcondition frommillis-non-number-throws fires only when the argument is NOT a
      // JavaScript number type (null, undefined, or a string). Since typeof NaN === 'number',
      // any expression that returns a JavaScript number (including NaN) satisfies the type check
      // and will NOT trigger the InvalidArgumentError throw. The contract notes this explicitly:
      //   "NaN is technically a number in JavaScript, so NaN does NOT trigger this throw"
      //
      // Common patterns that guarantee a number return and therefore cannot trigger the throw:
      //   - Math.max(x, 0), Math.min(x, limit), Math.floor(x), Math.ceil(x), Math.round(x), etc.
      //   - parseInt(str, 10), parseFloat(str)
      //   - Number(value)
      // All of these return typeof 'number', even when the result is NaN.
      //
      // The suppression also handles variable-assigned clamping (the backstage pattern):
      //   dt = Math.max(dt, 0);
      //   Duration.fromMillis(dt)  ← dt is guaranteed numeric, suppress
      // This is detected by looking for a preceding assignment of the variable from a
      // numeric-returning function within the same logical block (10-line lookback).
      //
      // Evidence: concern-20260712-lead-14 (key-14); backstage (Math.max clamped, 2 violations),
      // n8n-nodes-base (parseInt / Number coercions, 2 violations). Labelers A+C at 0.85-0.9
      // confidence marked all 4 as FP.
      if (
        detection.packageName === "luxon" &&
        (detection.functionName === "fromMillis" || detection.functionName === "fromSeconds") &&
        ts.isCallExpression(detection.node) &&
        detection.node.arguments.length > 0 &&
        this.isNumericGuaranteedExpression(detection.node.arguments[0], sourceFile, detection.node)
      ) {
        continue;
      }

      // next: NextResponse.redirect() is NOT the redirect() from next/navigation.
      // NextResponse.redirect() returns a Response object — it does NOT throw NEXT_REDIRECT.
      // Only redirect() imported from 'next/navigation' throws. Suppress when the call is
      // a static method on NextResponse (chain[0] === 'NextResponse').
      // Evidence: wave1-fp-harvester — 119+ FPs across cal.com, papermark, civitai.
      if (
        detection.packageName === "next" &&
        detection.functionName === "redirect" &&
        Array.isArray(detection.metadata?.chain) &&
        (detection.metadata.chain as string[])[0] === "NextResponse"
      ) {
        continue;
      }

      // next: deepen-stream-3 special patterns (2026-06-29).
      // These functions have INVERSE detection semantics (fire when inside try-catch,
      // fire when NOT awaited, fire based on call context, etc.) that cannot be handled
      // by the standard "fire when outside try-catch" flow. Intercept all detections
      // for these functions, handle them via handleNextSpecialPatterns(), and skip the
      // standard matching loop. Covers postconditions added in next contract v1.2.0:
      //   redirect-inside-try-catch, not-found-inside-try-catch,
      //   permanent-redirect-inside-try-catch (concern-20260712-lead-03):
      //     redirect/notFound/permanentRedirect throw control-flow errors — the
      //     violation is when they ARE inside try-catch (catch swallows the throw),
      //     not when they are outside try-catch (the correct usage).
      //   forbidden-inside-try-catch, unauthorized-inside-try-catch,
      //   connection-missing-await, connection-inside-after,
      //   draft-mode-missing-await, after-error-swallowed,
      //   update-tag-after-redirect, update-tag-outside-server-action,
      //   revalidate-after-redirect (concern-20260712-lead-08), revalidate-tag-after-redirect
      if (
        detection.packageName === "next" &&
        (detection.functionName === "redirect" ||
          detection.functionName === "notFound" ||
          detection.functionName === "permanentRedirect" ||
          detection.functionName === "forbidden" ||
          detection.functionName === "unauthorized" ||
          detection.functionName === "connection" ||
          detection.functionName === "draftMode" ||
          detection.functionName === "after" ||
          detection.functionName === "updateTag" ||
          detection.functionName === "revalidatePath" ||
          detection.functionName === "revalidateTag")
      ) {
        const nextViolation = this.handleNextSpecialPatterns(
          detection,
          sourceFile,
        );
        if (nextViolation) violations.push(nextViolation);
        continue;
      }

      let funcContract = this.findFunctionContract(
        contract,
        effectiveFunctionName,
        chainStr,
      );
      // Fallback: direct call on a default import (e.g. `rp(url)` where
      // `import rp = require('request-promise')`). The contract describes
      // the callable default export under `name: default`. Scoped narrowly
      // to depth=0 default imports so we never mis-route property-chain
      // calls like `axios.junkmethod()` onto a default function block.
      if (
        !funcContract &&
        detection.metadata?.depth === 0 &&
        detection.metadata?.importKind === "default"
      ) {
        funcContract = this.findFunctionContract(contract, "default", chainStr);
      }
      if (!funcContract) {
        continue;
      }

      // Get postconditions that require error handling.
      // Only fire when the postcondition declares a checkable outcome (throws OR returns).
      // This prevents firing on special-purpose postconditions (e.g., hardcoded-credentials)
      // that require non-try-catch handling V2 can't verify.
      // Excludes "throws: never" (e.g., safeParse — guaranteed not to throw).
      const postconditions = (funcContract.postconditions || []).filter(
        (p) =>
          (p.throws || p.returns) &&
          (p.severity === "error" || p.severity === "warning") &&
          p.throws !== "never",
      );

      if (postconditions.length === 0) {
        continue;
      }

      // For return-value patterns: skip (covered by throwing-function/property-chain)
      // EXCEPTION: jsonwebtoken jwt.decode() security postconditions are handled here
      // because decode() never throws — it always returns — so return-value detection
      // is correct, and the postconditions fire based on usage pattern, not try-catch.
      const isJwtDecodeSecurityPostcondition =
        detection.packageName === "jsonwebtoken" &&
        detection.functionName === "decode" &&
        postconditions.some(
          (p) =>
            p.id === "decode-used-for-authentication" ||
            p.id === "decode-null-return-not-checked",
        );
      if (
        !isJwtDecodeSecurityPostcondition &&
        (detection.pattern === "return-value" ||
          detection.pattern === "return-value-async")
      ) {
        continue;
      }

      // Track this as a real evaluated call site (pass or fail)
      this._callSitesByPackage.set(
        detection.packageName,
        (this._callSitesByPackage.get(detection.packageName) ?? 0) + 1,
      );

      // Determine handling type: postconditions with "null" in their ID (e.g.,
      // current-user-null-not-handled, get-token-null-not-handled, auth-null-not-checked)
      // require null-guard detection, not try-catch analysis.
      const primaryPostcondition = this.pickMostSevere(postconditions);

      // WAVE-2A: per-callsite detection-trace accumulator.
      // Instantiated AFTER primaryPostcondition is known (we need both
      // packageName + postconditionId for the accumulator context, and
      // postcondition selection happens here). Wave 2 sub-waves push to
      // `trace` via trace.record(...) at each guard's evaluation; the
      // accumulator's serialize() is attached to violation.detectionTrace
      // immediately before violations.push at the end of the loop body.
      //
      // CANONICAL PATTERN (Plans 01-04..01-08 must mirror this):
      //   1. Instantiate `trace` here, ONCE per loop iteration.
      //   2. At every short-circuit guard for this package family, emit a
      //      trace.record(MATCHER_IDS.X, "passed"|"failed", reason?) BEFORE
      //      the `continue`. Break OR-chains into N sequential record() calls
      //      (Pitfall 1 — bundled boolean status hides which matcher fired).
      //   3. When a passing matcher causes `continue`, ALSO push to
      //      this._lastPassedDetections so Wave 9 can mine the convention.
      //   4. At the violation construction site, assign
      //      `violation.detectionTrace = trace.serialize()` BEFORE
      //      violations.push.
      const trace = new DetectionTraceAccumulator({
        packageName: detection.packageName,
        postconditionId: primaryPostcondition.id,
      });

      // Special-case: react-hook-form handleSubmit — async-submit-unhandled-error
      // The postcondition only applies when the callback passed to handleSubmit is async.
      // Additionally, if the async callback's body is fully wrapped in try-catch, the
      // postcondition is already satisfied and should not fire.
      // Evidence: dashboard-feedback 2026-04-01 (concerns react-hook-form-1 and react-hook-form-2).
      // WAVE-2B: three sub-concerns each map to FRAMEWORK_REACT_HOOK_FORM passed.
      if (
        detection.packageName === "react-hook-form" &&
        detection.functionName === "handleSubmit" &&
        primaryPostcondition.id === "async-submit-unhandled-error" &&
        ts.isCallExpression(detection.node)
      ) {
        // Concern 1: if callback is NOT async, suppress — this postcondition does not apply.
        if (!this.controlFlow.isCallbackArgAsync(detection.node, 0)) {
          trace.record(MATCHER_IDS.FRAMEWORK_REACT_HOOK_FORM, "passed");
          this.recordPassedSite(
            detection,
            sourceFile,
            primaryPostcondition.id,
            MATCHER_IDS.FRAMEWORK_REACT_HOOK_FORM,
          );
          continue;
        }
        // Concern 2: if callback IS async and its body is fully wrapped in try-catch, suppress.
        if (
          this.controlFlow.isCallbackBodyFullyWrappedInTryCatch(
            detection.node,
            0,
          )
        ) {
          trace.record(MATCHER_IDS.FRAMEWORK_REACT_HOOK_FORM, "passed");
          this.recordPassedSite(
            detection,
            sourceFile,
            primaryPostcondition.id,
            MATCHER_IDS.FRAMEWORK_REACT_HOOK_FORM,
          );
          continue;
        }
        // Concern 3: if the file uses react-hook-form's setError() for error handling,
        // the developer is using RHF's built-in error state mechanism instead of try-catch.
        // This is the idiomatic RHF pattern — handleSubmit captures thrown errors and
        // routes them through setError. Both mechanisms satisfy the postcondition intent.
        // Evidence: concern-20260402-react-hook-form-1 — 60 FP instances, all using setError pattern.
        // Evidence: concern-2026-04-11-react-hook-form-3 — 60 more FP instances across auth forms,
        //           task forms, customer dialog forms that use toast.error, console.error, or
        //           server-side form actions with error state patterns.
        const rhfFileText = sourceFile.getFullText();
        if (
          rhfFileText.includes(".setError(") ||
          rhfFileText.includes("setError(") ||
          rhfFileText.includes("toast.error") ||
          rhfFileText.includes("toast(") ||
          rhfFileText.includes("sonner") ||
          rhfFileText.includes("useToast") ||
          rhfFileText.includes("onError") ||
          rhfFileText.includes("console.error")
        ) {
          trace.record(MATCHER_IDS.FRAMEWORK_REACT_HOOK_FORM, "passed");
          this.recordPassedSite(
            detection,
            sourceFile,
            primaryPostcondition.id,
            MATCHER_IDS.FRAMEWORK_REACT_HOOK_FORM,
          );
          continue;
        }
        // Callback is async and not fully wrapped — fall through to fire violation.
      }

      // yup cast: cast-type-error fires only when assert: true (the default).
      // Suppress when the call explicitly passes { assert: false } — yup returns
      // null/undefined instead of throwing in that mode.
      // Evidence: yup README cast options ("assert?: boolean = true"); ground-truth
      // fixture `castWithAssertFalse`.
      if (
        detection.packageName === "yup" &&
        detection.functionName === "cast" &&
        primaryPostcondition.id === "cast-type-error" &&
        ts.isCallExpression(detection.node)
      ) {
        const optionsArg = detection.node.arguments[1];
        if (optionsArg && ts.isObjectLiteralExpression(optionsArg)) {
          const assertProp = optionsArg.properties.find(
            (p): p is ts.PropertyAssignment =>
              ts.isPropertyAssignment(p) &&
              ts.isIdentifier(p.name) &&
              p.name.text === "assert",
          );
          if (assertProp && assertProp.initializer.kind === ts.SyntaxKind.FalseKeyword) {
            // WAVE-2F: yup cast({ assert: false }) returns null/undefined
            // instead of throwing — option explicitly disables the throw,
            // record SUPPRESSION_OPTION_SUPPRESSES as passed.
            trace.record(
              MATCHER_IDS.SUPPRESSION_OPTION_SUPPRESSES,
              "passed",
              "yup cast({ assert: false }) — option disables throw",
            );
            continue;
          }
        }
      }

      // react-hook-form trigger: trigger-result-not-awaited fires on every trigger() call
      // regardless of whether the caller awaits the Promise. Suppress when the call is the
      // direct operand of an AwaitExpression — those callers do await the result correctly.
      // Evidence: react-hook-form ground-truth line 257 (await form.trigger('email')).
      // WAVE-2B: awaited trigger() is the correct framework usage — record passed.
      if (
        detection.packageName === "react-hook-form" &&
        detection.functionName === "trigger" &&
        primaryPostcondition.id === "trigger-result-not-awaited" &&
        ts.isCallExpression(detection.node) &&
        ts.isAwaitExpression(detection.node.parent)
      ) {
        trace.record(MATCHER_IDS.FRAMEWORK_REACT_HOOK_FORM, "passed");
        this.recordPassedSite(
          detection,
          sourceFile,
          primaryPostcondition.id,
          MATCHER_IDS.FRAMEWORK_REACT_HOOK_FORM,
        );
        continue;
      }

      // react-hook-form useForm: async-default-values-unhandled-rejection fires on ANY
      // useForm({ defaultValues: ... }) call regardless of whether defaultValues is async.
      // Only fire when defaultValues is actually an async function or Promise-returning
      // expression. Sync object literals, sync function calls, and no-defaultValues calls
      // are all safe — suppress them.
      // Evidence: wave1-fp-harvester — 140+ FPs across cal.com (118), nango (21), civitai (1+).
      // WAVE-2B: every short-circuit in this block is a vacuous-satisfaction
      // pattern for async-default-values-unhandled-rejection (no args / no
      // options object / no defaultValues / sync defaultValues) — record
      // FRAMEWORK_REACT_HOOK_FORM passed for each.
      if (
        detection.packageName === "react-hook-form" &&
        detection.functionName === "useForm" &&
        primaryPostcondition.id === "async-default-values-unhandled-rejection" &&
        ts.isCallExpression(detection.node)
      ) {
        const args = detection.node.arguments;
        const recordPassedUseForm = (): void => {
          trace.record(MATCHER_IDS.FRAMEWORK_REACT_HOOK_FORM, "passed");
          this.recordPassedSite(
            detection,
            sourceFile,
            primaryPostcondition.id,
            MATCHER_IDS.FRAMEWORK_REACT_HOOK_FORM,
          );
        };
        if (args.length === 0) {
          recordPassedUseForm();
          continue;
        }
        const optionsArg = args[0];
        if (!ts.isObjectLiteralExpression(optionsArg)) {
          recordPassedUseForm();
          continue;
        }
        const defaultValuesProp = optionsArg.properties.find(
          (p): p is ts.PropertyAssignment =>
            ts.isPropertyAssignment(p) &&
            ts.isIdentifier(p.name) &&
            p.name.text === "defaultValues",
        );
        if (!defaultValuesProp) {
          recordPassedUseForm();
          continue;
        }
        const dv = defaultValuesProp.initializer;
        const isAsyncDefaultValues =
          (ts.isArrowFunction(dv) || ts.isFunctionExpression(dv)) &&
          !!dv.modifiers?.some(
            (m) => m.kind === ts.SyntaxKind.AsyncKeyword,
          );
        if (!isAsyncDefaultValues) {
          recordPassedUseForm();
          continue;
        }
      }

      // react-hook-form useFormContext: suppress missing-form-provider when
      // FormProvider (or `const Form = FormProvider` alias) appears in the file,
      // OR when the file uses useFormContext() — which is the sub-component pattern
      // where the component is designed to be nested inside a FormProvider by its caller.
      // Also suppress in shared UI component files (components/ui/, components/form)
      // that are reusable form primitives designed to work inside any FormProvider.
      // Evidence: concern-20260401-react-hook-form-3 (FormProvider in file),
      //           concern-2026-04-02-dashboard-react-hook-form-1 (useFormContext sub-components).
      //           concern-2026-04-11-react-hook-form-9 — 9 FP instances including
      //           components/Input.tsx, src/components/ui/form.tsx (shared form primitives).
      // react-hook-form useFormContext: suppress missing-form-provider when
      // FormProvider (or `const Form = FormProvider` alias) appears in the file,
      // OR when the file uses useFormContext() — which is the sub-component pattern
      // where the component is designed to be nested inside a FormProvider by its caller.
      // Also suppress in shared UI component files (components/ui/, components/form)
      // that are reusable form primitives designed to work inside any FormProvider.
      // Evidence: concern-20260401-react-hook-form-3 (FormProvider in file),
      //           concern-2026-04-02-dashboard-react-hook-form-1 (useFormContext sub-components).
      //           concern-2026-04-11-react-hook-form-9 — 9 FP instances including
      //           components/Input.tsx, src/components/ui/form.tsx (shared form primitives).
      //           concern-20260429-react-hook-form-2 — 6 FP instances in named sub-components
      //           like ArtistInstructionTextArea.tsx that are always rendered inside FormProvider.
      // WAVE-2B: FormProvider presence (file-level) or sub-component pattern is the
      // framework idiom that satisfies missing-form-provider — record passed.
      if (
        detection.packageName === "react-hook-form" &&
        primaryPostcondition.id === "missing-form-provider"
      ) {
        const rhfProviderFileText = sourceFile.getFullText();
        const rhfProviderFileName = sourceFile.fileName;
        if (
          rhfProviderFileText.includes("FormProvider") ||
          rhfProviderFileText.includes("useFormContext") ||
          /[/\\](ui|form|components?)[/\\](form|input|field)/i.test(rhfProviderFileName) ||
          /Input\.(tsx?|jsx?)$/.test(rhfProviderFileName) ||
          /[/\\]ui[/\\]form\.(tsx?|jsx?)$/.test(rhfProviderFileName) ||
          // Named form-field sub-components by suffix: *TextArea*, *Select*, *Checkbox*,
          // *Radio*, *Field*, *FormItem*, *FormControl*, *FormField* — always designed to
          // be rendered inside a FormProvider by their parent.
          /(TextArea|Select|Checkbox|Radio|Toggle|Switch|DatePicker|TimePicker|ColorPicker|Slider|Rating)\.(tsx?|jsx?)$/i.test(rhfProviderFileName)
        ) {
          trace.record(MATCHER_IDS.FRAMEWORK_REACT_HOOK_FORM, "passed");
          this.recordPassedSite(
            detection,
            sourceFile,
            primaryPostcondition.id,
            MATCHER_IDS.FRAMEWORK_REACT_HOOK_FORM,
          );
          continue;
        }
      }

      // express.json() and express.urlencoded(): these are middleware FACTORIES, not execution
      // contexts. The errors (SyntaxError, HttpError) happen when the returned middleware
      // processes a request, not when the factory is called. Suppress all postconditions
      // on express.json() and express.urlencoded() calls — they never throw at call time.
      // Evidence: concern-20260404-express-deepen-4 (ground-truth line 50, 112).
      // WAVE-2B: original suppression with no framework matcher attribution.
      // WAVE-2F: record SUPPRESSION_FACTORY_FUNCTION so the trace surface
      // shows the explicit reason ("factory function — never throws at call site").
      if (
        detection.packageName === "express" &&
        (detection.functionName === "json" ||
          detection.functionName === "urlencoded" ||
          detection.functionName === "static")
      ) {
        trace.record(
          MATCHER_IDS.SUPPRESSION_FACTORY_FUNCTION,
          "passed",
          `express.${detection.functionName}() — middleware factory, never throws at call time`,
        );
        continue;
      }

      // @neondatabase/serverless neon(): the neon(connectionString) factory call creates a
      // tagged-template SQL executor — it does NOT execute any SQL and does NOT throw.
      // Only the tagged-template calls (sql`SELECT ...`) and sql.query() / sql.transaction()
      // are the actual query sites that can throw NeonDbError.
      // The scanner detects neon() factory calls because `neon` is also in the contract's
      // functions list (for tagged-template detection via onTaggedTemplateExpression). When the
      // detection does NOT carry metadata.taggedTemplate=true it is the raw factory call, not a query.
      //
      // Evidence: concern-20260712-lead-10-neon-constructor-vs-query
      //   langchain-chat-sql and neon-clerk-drizzle-nextjs: neon(connectionString) calls at
      //   module level flagged as missing try-catch. No SQL is executed at this call site.
      //   Also documented in the contract.yaml note (factory call FP pattern).
      if (
        detection.packageName === "@neondatabase/serverless" &&
        detection.functionName === "neon" &&
        !detection.metadata?.taggedTemplate
      ) {
        trace.record(
          MATCHER_IDS.SUPPRESSION_FACTORY_FUNCTION,
          "passed",
          "neon(connectionString) factory constructor — creates SQL executor, does not execute SQL or throw",
        );
        continue;
      }

      // express app.listen(): suppress listen-eaddrinuse and listen-eacces entirely in the
      // throwing-function path. EADDRINUSE / EACCES are emitted as 'error' events on the
      // http.Server returned by app.listen() — they are NOT thrown exceptions and cannot be
      // caught with a try-catch around the listen() call. Firing this postcondition via the
      // throwing-function try-catch detection path produces misleading "missing try-catch"
      // guidance that is technically wrong. The correct check requires tracking the return
      // value of app.listen() and verifying that server.on('error', ...) is registered on it;
      // that detection path (event-listener absence on return value) is not yet implemented.
      //
      // concern-20260712-lead-23-express-listen-eaddrinuse-recommend-on-error: labeling data
      // confirmed 2/3 labelers at 0.75-0.85 confidence marked the firebase-users-admin
      // violation as FP because "try-catch cannot intercept EADDRINUSE". Suppress all
      // throwing-function path fires for these postconditions until return-value event-listener
      // tracking is implemented.
      //
      // Original suppression evidence: concern-20260404-express-deepen-5 (ground-truth line 185).
      // WAVE-2B: FRAMEWORK_EXPRESS_ASYNC_ERRORS is gated to async-* postcondition substrings
      // and would NOT apply here. WAVE-2F: record SUPPRESSION_PROJECT_ARCHITECTURE.
      if (
        detection.packageName === "express" &&
        detection.functionName === "listen" &&
        (primaryPostcondition.id === "listen-eaddrinuse" ||
          primaryPostcondition.id === "listen-eacces")
      ) {
        trace.record(
          MATCHER_IDS.SUPPRESSION_PROJECT_ARCHITECTURE,
          "passed",
          "listen-eaddrinuse / listen-eacces fire as 'error' events, not thrown exceptions — try-catch does not intercept them; scanner gap until return-value event-listener tracking is implemented",
        );
        continue;
      }

      // express app.use/METHOD: only fire async postconditions when the argument is
      // an async function. Sync factories (cors(), express.json()) and sync callbacks
      // must not trigger async-middleware-unhandled-rejection.
      // Full-body try-catch in the async callback also satisfies the postcondition.
      // Evidence: concern-20260401-express-1 (sync factory), -2 (full try-catch).
      if (
        detection.packageName === "express" &&
        ts.isCallExpression(detection.node)
      ) {
        const asyncPostconditions = [
          "async-middleware-unhandled-rejection",
          "async-route-handler-unhandled-rejection",
          "async-router-handler-unhandled-rejection",
          "async-router-middleware-unhandled-rejection",
        ];
        if (asyncPostconditions.includes(primaryPostcondition.id)) {
          // Find async function literal argument
          const asyncFuncArg = detection.node.arguments.find(
            (arg): arg is ts.ArrowFunction | ts.FunctionExpression => {
              if (!ts.isArrowFunction(arg) && !ts.isFunctionExpression(arg))
                return false;
              return (
                (
                  arg as ts.ArrowFunction | ts.FunctionExpression
                ).modifiers?.some(
                  (m) => m.kind === ts.SyntaxKind.AsyncKeyword,
                ) ?? false
              );
            },
          );
          // No async function arg → factory/sync middleware → suppress (concern-1)
          // WAVE-2B: not an async-error guard — the postcondition simply doesn't apply.
          // Record FRAMEWORK_EXPRESS_ASYNC_ERRORS as passed (the framework idiom of
          // "sync middleware factory or no async handler" satisfies the async-middleware
          // postcondition vacuously).
          if (!asyncFuncArg) {
            trace.record(
              MATCHER_IDS.FRAMEWORK_EXPRESS_ASYNC_ERRORS,
              "passed",
            );
            this.recordPassedSite(
              detection,
              sourceFile,
              primaryPostcondition.id,
              MATCHER_IDS.FRAMEWORK_EXPRESS_ASYNC_ERRORS,
            );
            continue;
          }
          // Entire async body is a single try-catch → suppress (concern-2)
          // WAVE-2B: try-catch inside the callback is the canonical guard for async
          // express middleware — record FRAMEWORK_EXPRESS_ASYNC_ERRORS as passed.
          if (ts.isBlock(asyncFuncArg.body)) {
            const stmts = asyncFuncArg.body.statements;
            if (
              stmts.length === 1 &&
              ts.isTryStatement(stmts[0]) &&
              stmts[0].catchClause
            ) {
              trace.record(
                MATCHER_IDS.FRAMEWORK_EXPRESS_ASYNC_ERRORS,
                "passed",
              );
              this.recordPassedSite(
                detection,
                sourceFile,
                primaryPostcondition.id,
                MATCHER_IDS.FRAMEWORK_EXPRESS_ASYNC_ERRORS,
              );
              continue;
            }
          }

          // express-async-errors imported → suppress async-middleware-unhandled-rejection
          // globally for the file. express-async-errors patches Express to forward all
          // async rejections to the next error handler, making individual try-catch
          // unnecessary for all middleware in the file.
          // Evidence: concern-2026-04-20-express-1 — 5 FPs in api/dev-server.ts and
          //   api/browser-agent-server.ts which use express-async-errors for global handling.
          // WAVE-2B: this is the namesake guard for FRAMEWORK_EXPRESS_ASYNC_ERRORS —
          // record as passed.
          if (
            primaryPostcondition.id === "async-middleware-unhandled-rejection" &&
            sourceFile.getFullText().includes("express-async-errors")
          ) {
            trace.record(
              MATCHER_IDS.FRAMEWORK_EXPRESS_ASYNC_ERRORS,
              "passed",
            );
            this.recordPassedSite(
              detection,
              sourceFile,
              primaryPostcondition.id,
              MATCHER_IDS.FRAMEWORK_EXPRESS_ASYNC_ERRORS,
            );
            continue; // express-async-errors installed — global rejection forwarding active
          }
        }
      }

      // fastify route methods (get/post/put/delete/patch/options/head/route): suppress
      // route-handler-async-error when the async handler callback has its body fully
      // wrapped in try-catch. The try-catch is inside the callback, not around the
      // app.get() call itself — but that's the correct pattern for fastify route handlers.
      // The callback argument is the last argument (after optional options objects).
      // Evidence: concern-20260413-dashboard-fastify-1 (line 51: SHOULD_NOT_FIRE with try-catch).
      // WAVE-2B: try-catch inside the route handler callback is the canonical
      // FRAMEWORK_FASTIFY_ROUTE guard — record passed.
      if (
        detection.packageName === "fastify" &&
        primaryPostcondition.id === "route-handler-async-error" &&
        ts.isCallExpression(detection.node)
      ) {
        const routeMethods = new Set(["get","post","put","delete","patch","options","head","route","all"]);
        if (routeMethods.has(detection.functionName)) {
          // Find the last function-like argument (handler callback) and check try-catch
          const args = detection.node.arguments;
          let handlerFullyWrapped = false;
          for (let i = args.length - 1; i >= 0; i--) {
            const arg = args[i];
            if (ts.isArrowFunction(arg) || ts.isFunctionExpression(arg)) {
              const isAsync = (arg as ts.ArrowFunction | ts.FunctionExpression)
                .modifiers?.some(m => m.kind === ts.SyntaxKind.AsyncKeyword) ?? false;
              if (isAsync && this.controlFlow.isCallbackBodyFullyWrappedInTryCatch(detection.node, i)) {
                handlerFullyWrapped = true;
              }
              break;
            }
          }
          if (handlerFullyWrapped) {
            trace.record(MATCHER_IDS.FRAMEWORK_FASTIFY_ROUTE, "passed");
            this.recordPassedSite(
              detection,
              sourceFile,
              primaryPostcondition.id,
              MATCHER_IDS.FRAMEWORK_FASTIFY_ROUTE,
            );
            continue;
          }
        }
      }

      // fastify setErrorHandler(): suppress seterrorhandler-called-after-start when
      // no `listen()` or `ready()` call has been awaited before this setErrorHandler()
      // call in the same function scope. The postcondition only fires when called after
      // the server is already started (listen/ready already awaited).
      // If no listen()/ready() precedes this call in the enclosing function, it's safe.
      // Evidence: concern-20260413-fastify-deepen-1 ground-truth line 200 (SHOULD_NOT_FIRE).
      if (
        detection.packageName === "fastify" &&
        detection.functionName === "setErrorHandler" &&
        primaryPostcondition.id === "seterrorhandler-called-after-start" &&
        ts.isCallExpression(detection.node)
      ) {
        // Walk up to find the enclosing function body (or source file)
        let enclosingBody: ts.Block | ts.SourceFile | undefined;
        let cur: ts.Node | undefined = detection.node.parent;
        while (cur) {
          if (ts.isBlock(cur) && cur.parent && (
            ts.isFunctionDeclaration(cur.parent) ||
            ts.isFunctionExpression(cur.parent) ||
            ts.isArrowFunction(cur.parent) ||
            ts.isMethodDeclaration(cur.parent)
          )) {
            enclosingBody = cur;
            break;
          }
          if (ts.isSourceFile(cur)) {
            enclosingBody = cur;
            break;
          }
          cur = cur.parent;
        }
        if (enclosingBody) {
          // Check if any await listen/ready call appears before setErrorHandler in the body
          const stmts = (enclosingBody as ts.Block | ts.SourceFile).statements;
          // Find index of the statement containing setErrorHandler
          let setErrorHandlerStmtIdx = -1;
          for (let si = 0; si < stmts.length; si++) {
            let found = false;
            const visit = (n: ts.Node): void => {
              if (n === detection.node) { found = true; return; }
              if (!found) ts.forEachChild(n, visit);
            };
            visit(stmts[si]);
            if (found) { setErrorHandlerStmtIdx = si; break; }
          }
          // Check if any await+listen/ready appears in earlier statements
          let hasPrecedingAwaitedListen = false;
          for (let si = 0; si < setErrorHandlerStmtIdx; si++) {
            const text = stmts[si].getText(sourceFile);
            if (/await\s+\w+\.(listen|ready)\s*\(/.test(text)) {
              hasPrecedingAwaitedListen = true;
              break;
            }
          }
          // If no preceding listen/ready, this is setErrorHandler before start — suppress
          // WAVE-2B: setErrorHandler called before listen()/ready() is the
          // framework-intended pattern — record FRAMEWORK_FASTIFY_ROUTE passed.
          if (!hasPrecedingAwaitedListen) {
            trace.record(MATCHER_IDS.FRAMEWORK_FASTIFY_ROUTE, "passed");
            this.recordPassedSite(
              detection,
              sourceFile,
              primaryPostcondition.id,
              MATCHER_IDS.FRAMEWORK_FASTIFY_ROUTE,
            );
            continue;
          }
        }
      }

      // puppeteer browser.close() inside a catch or finally clause: calling close in
      // the error-handling branch (catch) or guaranteed-execution branch (finally)
      // satisfies browser-close-must-run.
      // Evidence: concern-20260401-puppeteer-1 (catch), concern-20260401-puppeteer-2 (finally).
      if (
        detection.packageName === "puppeteer" &&
        detection.functionName === "close"
      ) {
        let cur: ts.Node | undefined = detection.node;
        let inCatchOrFinally = false;
        while (cur) {
          if (ts.isCatchClause(cur)) {
            inCatchOrFinally = true;
            break;
          }
          // ts.TryStatement.finallyBlock is a Block node — check if we're inside it
          if (
            ts.isBlock(cur) &&
            cur.parent &&
            ts.isTryStatement(cur.parent) &&
            cur.parent.finallyBlock === cur
          ) {
            inCatchOrFinally = true;
            break;
          }
          if (
            ts.isFunctionDeclaration(cur) ||
            ts.isFunctionExpression(cur) ||
            ts.isArrowFunction(cur) ||
            ts.isMethodDeclaration(cur)
          )
            break;
          cur = cur.parent;
        }
        if (inCatchOrFinally) {
          // WAVE-2E: puppeteer close() in catch/finally is the canonical cleanup
          // pattern — record FINALLY_CLOSE as passed and capture the site for
          // the Wave 9 convention miner.
          trace.record(MATCHER_IDS.FINALLY_CLOSE, "passed");
          this.recordPassedSite(
            detection,
            sourceFile,
            primaryPostcondition.id,
            MATCHER_IDS.FINALLY_CLOSE,
          );
          continue;
        }
      }

      // puppeteer browser-close-must-run: suppress when the launch() call is inside a
      // try statement that has a finally block containing a .close() call. The pattern
      //   try { browser = await puppeteer.launch(); ... } finally { await browser.close(); }
      // correctly satisfies browser-close-must-run even without a catch clause.
      // Standard isInTryCatch() returns false for try-finally (no catch), causing FPs.
      // Evidence: concern-2026-04-20-puppeteer-feedback-20 — 1 FP:
      //   api/browser-agent-executor.ts using try-finally pattern.
      if (
        detection.packageName === "puppeteer" &&
        primaryPostcondition.id === "browser-close-must-run"
      ) {
        // Walk up to find the enclosing try statement
        let puppeteerCur: ts.Node | undefined = detection.node.parent;
        let enclosingTry: ts.TryStatement | undefined;
        while (puppeteerCur) {
          if (ts.isTryStatement(puppeteerCur)) {
            // Verify the detection node is in the try block (not in catch/finally)
            if (this.controlFlow.isInTryCatch(detection.node) || puppeteerCur.finallyBlock) {
              enclosingTry = puppeteerCur;
              break;
            }
          }
          if (
            ts.isFunctionDeclaration(puppeteerCur) ||
            ts.isFunctionExpression(puppeteerCur) ||
            ts.isArrowFunction(puppeteerCur) ||
            ts.isMethodDeclaration(puppeteerCur)
          )
            break;
          puppeteerCur = puppeteerCur.parent;
        }
        if (enclosingTry?.finallyBlock) {
          // Check if the finally block contains a .close() call
          let hasCloseInFinally = false;
          const checkForClose = (node: ts.Node): void => {
            if (hasCloseInFinally) return;
            if (
              ts.isCallExpression(node) &&
              ts.isPropertyAccessExpression(node.expression) &&
              node.expression.name.text === "close"
            ) {
              hasCloseInFinally = true;
              return;
            }
            ts.forEachChild(node, checkForClose);
          };
          checkForClose(enclosingTry.finallyBlock);
          if (hasCloseInFinally) {
            // WAVE-2E: puppeteer try-finally { browser.close() } around launch()
            // — record FINALLY_CLOSE as passed and capture the site for the
            // Wave 9 convention miner.
            trace.record(MATCHER_IDS.FINALLY_CLOSE, "passed");
            this.recordPassedSite(
              detection,
              sourceFile,
              primaryPostcondition.id,
              MATCHER_IDS.FINALLY_CLOSE,
            );
            continue; // try-finally with close() — postcondition satisfied
          }
        }
      }

      // simple-git: suppress all missing-try-catch violations when the call is
      // directly inside a catch {} block (without crossing a function boundary).
      // A catch block is already an error-handling context — git.push() inside catch
      // is a fallback/retry operation and the enclosing error is already being handled.
      // Evidence: concern-2026-04-02-simple-git-catch-block-fp
      // (Vinzent03/obsidian-git src/gitManager/simpleGit.ts:1024)
      if (detection.packageName === "simple-git") {
        let cur: ts.Node | undefined = detection.node;
        let inCatchBlock = false;
        while (cur) {
          if (ts.isCatchClause(cur)) {
            inCatchBlock = true;
            break;
          }
          if (
            ts.isFunctionDeclaration(cur) ||
            ts.isFunctionExpression(cur) ||
            ts.isArrowFunction(cur) ||
            ts.isMethodDeclaration(cur)
          )
            break;
          cur = cur.parent;
        }
        if (inCatchBlock) {
          // WAVE-2F: simple-git call inside a catch{} block — fallback/retry
          // operation, the enclosing error is already being handled.
          trace.record(
            MATCHER_IDS.SUPPRESSION_INSIDE_CATCH,
            "passed",
            "simple-git call is inside an enclosing catch block — fallback path",
          );
          continue;
        }
      }

      // dotenv config(): in normal (non-vault) mode, config() NEVER throws — it returns
      // { error } on failure and { parsed } on success. Suppress missing-env-file and
      // parse-error (now info-level in YAML). Vault postconditions only fire when the
      // file contains vault indicators (DOTENV_KEY, .env.vault).
      // Evidence: concern-20260401-dotenv-1, civitai audit 2026-05-05 — 1 FP.
      if (
        detection.packageName === "dotenv" &&
        detection.functionName === "config"
      ) {
        if (
          primaryPostcondition.id === "missing-env-file" ||
          primaryPostcondition.id === "parse-error"
        ) {
          // WAVE-2F: dotenv.config() returns { error } on failure in non-vault
          // mode — never throws, so try-catch is irrelevant.
          trace.record(
            MATCHER_IDS.SUPPRESSION_NEVER_THROWS,
            "passed",
            "dotenv.config() returns { error } on failure — does not throw",
          );
          continue;
        }
        // Vault postconditions only apply when the file uses vault mode.
        // Detect actual vault USAGE (setting/reading DOTENV_KEY, referencing .env.vault),
        // not mere string mentions in error-code checks (e.g., INVALID_DOTENV_KEY).
        if (primaryPostcondition.id.startsWith("vault-")) {
          const fileText = sourceFile.getFullText();
          const hasVaultUsage =
            /process\.env\.DOTENV_KEY\b/.test(fileText) ||
            /process\.env\[['"]DOTENV_KEY['"]\]/.test(fileText) ||
            /\.env\.vault\b/.test(fileText) ||
            /['"]\.env\.vault['"]/.test(fileText);
          if (!hasVaultUsage) {
            // WAVE-2F: file does not use vault mode — vault-* postcondition
            // does not apply at this callsite.
            trace.record(
              MATCHER_IDS.SUPPRESSION_FILE_SCOPE,
              "passed",
              "file does not use dotenv vault mode — vault-* postcondition not applicable",
            );
            continue;
          }
        }
      }

      // @vercel/blob: Promise.allSettled() absorbs all rejections from the promises in its
      // array — calls inside allSettled([del(url1), del(url2)]) can never propagate errors.
      // This is a valid error boundary equivalent to try-catch for the contained promises.
      // Evidence: concern-20260402-vercel-blob-1 — del() inside Promise.allSettled() is safe.
      if (detection.packageName === "@vercel/blob") {
        // Walk up to find if this call is an argument of Promise.allSettled()
        let cur: ts.Node | undefined = detection.node;
        let inAllSettled = false;
        while (cur) {
          if (
            ts.isCallExpression(cur) &&
            ts.isPropertyAccessExpression(cur.expression) &&
            cur.expression.name.text === "allSettled" &&
            ts.isIdentifier(cur.expression.expression) &&
            cur.expression.expression.text === "Promise"
          ) {
            inAllSettled = true;
            break;
          }
          if (
            ts.isFunctionDeclaration(cur) ||
            ts.isFunctionExpression(cur) ||
            ts.isArrowFunction(cur) ||
            ts.isMethodDeclaration(cur)
          ) {
            break;
          }
          cur = cur.parent;
        }
        if (inAllSettled) {
          // WAVE-2F: Promise.allSettled() absorbs all rejections from contained
          // promises — equivalent to a try-catch boundary at the array level.
          trace.record(
            MATCHER_IDS.SUPPRESSION_PROMISE_ABSORBED,
            "passed",
            "call is an element of Promise.allSettled([...]) — rejections absorbed",
          );
          continue;
        }

        // @vercel/blob: suppress blob-del-no-try-catch in server-side request handler files.
        // Handler files in lib/sandbox/, api/, or similar server-side directories are invoked
        // by framework routing (Next.js, Express, custom HTTP servers) that provides a
        // framework-level error boundary — uncaught errors become 500 responses, not process crashes.
        // Evidence: concern-2026-04-20-vercel-blob-feedback-16 — 2 FPs:
        //   lib/sandbox/postSandboxesFilesHandler.ts:87 (server handler in /sandbox/ directory).
        if (
          primaryPostcondition.id === "blob-del-no-try-catch" &&
          (/[/\\](sandbox|handlers?|routes?|controllers?)[/\\]/i.test(sourceFile.fileName) ||
            /Handler\.(ts|tsx)$/.test(sourceFile.fileName))
        ) {
          // WAVE-2F: server-side handler file — framework error boundary
          // turns uncaught errors into 500 responses.
          trace.record(
            MATCHER_IDS.SUPPRESSION_FRAMEWORK_BOUNDARY,
            "passed",
            "server-side handler file — framework error boundary handles uncaught errors",
          );
          continue;
        }
      }

      // ai (Vercel AI SDK) tool(): the tool() function is a factory that creates a tool
      // definition, not an execution context. The execute callback is always called by the
      // SDK's own tool-invocation pipeline which wraps it in its own error boundary.
      // tool-execution-error and tool-schema-validation-error therefore cannot propagate
      // as unhandled exceptions from the tool() call site itself.
      // Evidence: concern-20260402-ai-2 — 25 FP instances across tool definition files.
      if (
        detection.packageName === "ai" &&
        detection.functionName === "tool" &&
        (primaryPostcondition.id === "tool-execution-error" ||
          primaryPostcondition.id === "tool-schema-validation-error")
      ) {
        // WAVE-2F: ai.tool() is a factory that creates a tool definition;
        // the execute callback is invoked by the SDK's own pipeline which
        // wraps it in its own error boundary.
        trace.record(
          MATCHER_IDS.SUPPRESSION_FACTORY_FUNCTION,
          "passed",
          "ai.tool() factory — execute callback runs inside SDK error boundary",
        );
        continue;
      }

      // ai (Vercel AI SDK): tool-execution-error fires on async functions exported from
      // files in a tools/ directory — these are standalone execute-callback implementations
      // that are composed into tool() at the call site. The try-catch responsibility lies
      // with the tool() caller, not the individual execute function.
      // Pattern: lib/tools/*.ts, tools/*.ts — files that export individual tool handlers
      // Evidence: concern-2026-04-20-ai-1 — 25 FP instances (searchTwitter.ts,
      //   getArtistSegments.ts, getSocialPosts.ts, browser/browserObserve.ts, etc.)
      if (
        detection.packageName === "ai" &&
        primaryPostcondition.id === "tool-execution-error" &&
        /[/\\]tools?[/\\]/i.test(sourceFile.fileName)
      ) {
        // WAVE-2F: tools/ directory file — SDK runtime manages errors at
        // the tool() invocation site, not at the individual execute function.
        trace.record(
          MATCHER_IDS.SUPPRESSION_FILE_SCOPE,
          "passed",
          "tools/ directory file — SDK manages errors at invocation",
        );
        continue;
      }

      // ai (Vercel AI SDK): api-error-rate-limit fires on AI SDK calls inside eval harness
      // functions, batch processing utilities, and AI utility/wrapper files. These are not
      // direct user-facing call sites — the orchestration layer or utility wrapper manages
      // rate limit errors. The individual scorer/analyzer/utility functions are not the
      // correct place to require try-catch.
      // Evidence: concern-2026-04-20-ai-2 — 7 FP instances in lib/evals/scorers/*,
      //   lib/catalog/analyzeCatalogBatch.ts, lib/ai/generateArray.ts
      // Evidence: concern-20260429-ai-2 — 7 FP instances in apps/web/utils/llms/index.ts
      //   (utility wrapper that exposes AI SDK calls; callers handle rate limits).
      if (
        detection.packageName === "ai" &&
        primaryPostcondition.id === "api-error-rate-limit" &&
        (/[/\\]evals?[/\\]/i.test(sourceFile.fileName) ||
          /[/\\]catalog[/\\]/i.test(sourceFile.fileName) ||
          /[/\\]scorers?[/\\]/i.test(sourceFile.fileName) ||
          /[/\\]llms?[/\\]/i.test(sourceFile.fileName) ||
          /[/\\]utils?[/\\]llms?/i.test(sourceFile.fileName))
      ) {
        // WAVE-2F: eval/batch/utility file — harness or caller manages rate limits.
        trace.record(
          MATCHER_IDS.SUPPRESSION_FILE_SCOPE,
          "passed",
          "eval/batch/utility file — harness or caller manages rate limits",
        );
        continue;
      }

      // @tanstack/react-router: TypeScript-generated route trees enforce path and param
      // correctness at compile time — invalid paths cannot reach runtime in a typed project.
      // Suppress invalid-route-path, param-type-mismatch, and search-schema-validation-error
      // unconditionally for all @tanstack/react-router projects.
      //
      // Original (cycle-7) implementation gated suppression on routeTree.gen.ts presence, but
      // 126 FP instances remained because: (a) some projects use manual route definitions with
      // TanStack Router (no routeTree.gen.ts), (b) some projects store routeTree.gen.ts at
      // non-standard paths not in the candidate list. TanStack Router's typed routing is the
      // core feature of the package — ALL projects benefit from compile-time path validation
      // regardless of whether they use file-system routing or manual createRouter().
      //
      // Evidence: concern-20260401-tanstack-react-router-1, -2, -3 (cycle-7 implementation).
      //           concern-20260402-tanstack-react-router-1 (126 FPs remaining post-cycle-7).
      if (detection.packageName === "@tanstack/react-router") {
        const tanStackTypedPostconditions = new Set([
          "invalid-route-path",
          "invalid-route-link",
          "invalid-route-navigate",
          "param-type-mismatch",
          "invalid-params",
          "invalid-link-params",
          "search-schema-validation-error",
          // concern-20260712-lead-02-tanstack-router-useparams-typed:
          // Route.useParams() is the typed, route-bound variant — TypeScript enforces param
          // presence at compile time via the file-route type. required-param-missing is always
          // a false positive for this accessor; the optional generic <T> further confirms the
          // caller controls the type contract. Evidence: vendure (9 FP), tianji (FP).
          "required-param-missing",
        ]);
        if (tanStackTypedPostconditions.has(primaryPostcondition.id)) {
          // WAVE-2F: TanStack Router's TypeScript-generated route trees
          // enforce path/param correctness at compile time — invalid paths
          // cannot reach runtime in a typed project.
          trace.record(
            MATCHER_IDS.SUPPRESSION_TYPED_ROUTING,
            "passed",
            "TanStack Router typed routing — compile-time path/param validation",
          );
          continue;
        }

        // §3 generalization: loader-error-unhandled fires on async lambdas inside
        // `createRoute({ loader: async () => ... })` / `createFileRoute(...)` route
        // configs. TanStack Router's route config catches loader exceptions and routes
        // to the `errorComponent` — framework owns the catch, same shape as react-query
        // useQuery being covered by a top-level error boundary. The project-level signal
        // (QueryCache(onError) / ErrorBoundary file / central error handler module) is
        // applied as additional confidence — many TanStack projects share these wirings
        // between React Query and React Router code.
        //
        // Evidence: concern-20260515-section3-gap-3-router-loader-callbacks (~34 FPs at
        //   vendure rank-24; scanner-upgrades-todo.md line 46).
        if (primaryPostcondition.id === "loader-error-unhandled") {
          if (this.isInsideReactRouterLoaderCallback(detection.node)) {
            // WAVE-2F: inside createRoute({ loader: ... }) — router config
            // catches loader exceptions and routes to errorComponent.
            trace.record(
              MATCHER_IDS.SUPPRESSION_FRAMEWORK_BOUNDARY,
              "passed",
              "inside TanStack Router loader callback — errorComponent handles throws",
            );
            continue;
          }
          if (this.projectHasReactQueryGlobalErrorHandler()) {
            // WAVE-2F: project has global React Query error handler that
            // catches cross-file loader errors.
            trace.record(
              MATCHER_IDS.SUPPRESSION_PROJECT_ARCHITECTURE,
              "passed",
              "project has global QueryCache(onError) / ErrorBoundary handler",
            );
            continue;
          }
        }
      }

      // @trpc/client: PromiseCall / PromiseState / safeAsync etc. callback-wrapper shells.
      // When `.query()` / `.mutate()` is called inside an async lambda passed as either:
      //   (a) the direct argument to a CallExpression / NewExpression whose callee is a
      //       top-of-file imported Identifier matching the wrapper-name pattern list, OR
      //   (b) the value of a `function:` / `init:` / `callback:` / `fn:` property of an
      //       object literal that is itself such an argument,
      // the try-catch lives in the wrapper class/function one stack frame up. Scanner
      // would otherwise FP because it walks only the immediate callback body.
      //
      // Evidence: concern-20260515-section8-promisecall-promisestate-wrapper-shells (~416
      //   FPs across blinko, rybbit, gpt4free-ts) and
      //   concern-20260515-section8-trpc-query-wrapper-shells (~100 FPs). Canonical shape:
      //   blinko's PromiseCall(<promise>) helper and `new PromiseState({ function: async ...})`
      //   class (app/src/store/standard/PromiseState.ts).
      //
      // Gated on (a) imported-at-file-level constraint to prevent name-collision over-
      // suppression: a locally-declared function named `PromiseCall` that is NOT imported
      // does NOT match. Project-level extension via `.nark/suppress.yaml` callback_wrappers.
      if (
        detection.packageName === "@trpc/client" &&
        (primaryPostcondition.id === "trpc-mutate-missing-try-catch" ||
          primaryPostcondition.id === "trpc-query-missing-try-catch")
      ) {
        if (this.isInsideCallbackWrapperShell(detection.node, sourceFile)) {
          // WAVE-2F: trpc call inside a PromiseCall / PromiseState / safeAsync
          // callback wrapper shell — try-catch lives in the wrapper class one
          // stack frame up.
          trace.record(
            MATCHER_IDS.SUPPRESSION_CALLBACK_WRAPPER_SHELL,
            "passed",
            "trpc call inside imported callback-wrapper shell — wrapper owns try-catch",
          );
          continue;
        }
      }

      // §10: data-layer architectural pattern (Controller -> Service -> Model/Repository).
      // Three-layer-architecture projects intentionally let raw ORM errors propagate from
      // data-layer files to a central errorHandler middleware at the app boundary. The
      // scanner previously flagged every per-callsite ORM operation without try-catch,
      // producing massive FPs in Model and Repository files.
      //
      // Gate: detection package is knex (Phase 1) OR typeorm (Phase 2), AND the callsite
      // is in a data-layer file (*Model.ts, *Repository.ts, *.repository.ts, or under
      // /models/ /model/ /repositories/ /repository/), AND the project has a central
      // errorHandler middleware. When BOTH conditions hold the project has explicitly
      // opted into central error handling and the per-callsite postcondition has no
      // remaining concern to surface.
      //
      // Phase 1 evidence: concern-20260518-section10-knex-model-layer-fps (rank-14
      //   lightdash, 1,050 FPs in *Model.ts files; central errorHandler at
      //   packages/backend/src/App.ts:736-768 and translation at errors.ts:29-51).
      //
      // Phase 2 evidence: rsschool-app server (2026-05-18, this commit) — 28 typeorm
      //   violations in *.repository.ts files routed through Koa's errorHandlerMiddleware
      //   at server/src/routes/logging.ts:13.
      //
      // Prisma model-class pattern is an anticipated Phase 3 analog deferred to a
      // follow-up ship pending empirical verification.
      if (
        detection.packageName === "knex" &&
        SECTION_10_KNEX_GATED_POSTCONDITIONS.has(primaryPostcondition.id)
      ) {
        if (
          this.isCallInDataLayerFile(sourceFile) &&
          this.projectHasCentralErrorHandlerMiddleware()
        ) {
          // WAVE-2C: SECTION_10 data-layer + central errorHandler is the
          // architectural pattern guard for knex Model-file per-callsite
          // postconditions — record passed.
          trace.record(MATCHER_IDS.ARCHITECTURAL_DATA_LAYER, "passed");
          this.recordPassedSite(
            detection,
            sourceFile,
            primaryPostcondition.id,
            MATCHER_IDS.ARCHITECTURAL_DATA_LAYER,
          );
          continue;
        }
      }

      // §10 Phase 2: typeorm Repository-layer architectural pattern.
      // Same gate shape as Phase 1, applied to typeorm. The 22 gated postconditions are
      // all per-callsite error-throw checks (QueryFailedError, EntityNotFoundError,
      // constraint violations, missing-column errors at runtime). Logic checks
      // (*-silent-no-op), security checks (query-sql-injection-risk), and lifecycle
      // checks (initialize-*, destroy-*, datasource-initialization,
      // optimistic-locking-version-mismatch) are intentionally NOT gated.
      if (
        detection.packageName === "typeorm" &&
        SECTION_10_TYPEORM_GATED_POSTCONDITIONS.has(primaryPostcondition.id)
      ) {
        if (
          this.isCallInDataLayerFile(sourceFile) &&
          this.projectHasCentralErrorHandlerMiddleware()
        ) {
          // WAVE-2C: SECTION_10 data-layer + central errorHandler is the
          // architectural pattern guard for typeorm Repository-file per-callsite
          // postconditions — record passed.
          trace.record(MATCHER_IDS.ARCHITECTURAL_DATA_LAYER, "passed");
          this.recordPassedSite(
            detection,
            sourceFile,
            primaryPostcondition.id,
            MATCHER_IDS.ARCHITECTURAL_DATA_LAYER,
          );
          continue;
        }
      }

      // Promise(executor) callback-err-guard: when the contracted call site sits inside
      // `new Promise((resolve, reject) => ...)` and its callback propagates `err` via
      // `reject(err)`, the rejection surfaces at the outer `await` — that's where the
      // user's try/catch belongs, not at the inner registration. Package-agnostic on
      // purpose: canonical promisify shape across ssh2, snowflake-sdk, mongodb native
      // cb-API, and generic node-style cb wrappers.
      //
      // Evidence: 2026-06-23 audit-stream wave 1+2 candidate #4
      // (callback-err-guard-in-promise-wrapper-not-detected) — 3+ occurrences across 2
      // distinct repos (matt1398/claude-devtools ssh2.exec; growthbook/back-end
      // snowflake-sdk.connect + .execute `complete:` named-prop variant).
      if (
        ts.isCallExpression(detection.node) &&
        this.isCallbackErrGuardedInPromiseExecutor(detection.node)
      ) {
        // WAVE-2C: Promise(executor) reject(err) is the package-agnostic guard
        // for callback-shaped contracts (mongoose / mysql2 / pg native cb-API,
        // ssh2.exec, snowflake-sdk.connect, generic cb-promisify). Record passed
        // so the trace shows we considered the promise-executor matcher.
        trace.record(MATCHER_IDS.PROMISE_EXECUTOR_REJECT, "passed");
        this.recordPassedSite(
          detection,
          sourceFile,
          primaryPostcondition.id,
          MATCHER_IDS.PROMISE_EXECUTOR_REJECT,
        );
        continue;
      }

      // §11.C: Fastify lifecycle hooks (addHook with onRequest/preHandler/etc.) route
      // uncaught throws through the same setErrorHandler chain as route handlers (per
      // fastify v5's lib/hooks.js#hookRunnerGenerator). When the project registers a
      // setErrorHandler anywhere in source, the per-hook try-catch postcondition has no
      // remaining concern — the framework owns the catch.
      //
      // Scope: addhook-async-hook-no-try-catch only. The sibling
      // addhook-onclose-async-unhandled postcondition is NOT suppressed because onClose
      // runs at shutdown and does NOT flow into setErrorHandler.
      //
      // Note: the postcondition is already specific to Fastify lifecycle hooks at the
      // detection layer (per the fastify contract.yaml addHook entry), so this gate
      // doesn't need an AST walker — the postcondition ID itself is the per-callsite
      // signal. The corpus interim downgraded this clause from error to warning
      // (nark-corpus@67271c8). This scanner-side gate goes further: full suppression
      // when the framework-ownership signal is present.
      //
      // Evidence: misskey backend has 10 of these warnings with Fastify setErrorHandler
      // configured at ClientServerService.ts:924; rybbit has more without one (the
      // rybbit hits stay as real signals because no project-level setErrorHandler).
      if (
        detection.packageName === "fastify" &&
        primaryPostcondition.id === "addhook-async-hook-no-try-catch"
      ) {
        if (this.projectHasCentralErrorHandlerMiddleware()) {
          // WAVE-2B: project-wide setErrorHandler is the framework-pattern
          // guard for addhook-async-hook-no-try-catch — record passed.
          trace.record(MATCHER_IDS.FRAMEWORK_FASTIFY_ROUTE, "passed");
          this.recordPassedSite(
            detection,
            sourceFile,
            primaryPostcondition.id,
            MATCHER_IDS.FRAMEWORK_FASTIFY_ROUTE,
          );
          continue;
        }
      }

      // stripe: retry/backoff wrappers satisfy Stripe error postconditions.
      // When a Stripe call is inside a function argument of a retry utility (e.g., pRetry,
      // withRetry, retryWithBackoff, exponentialBackoff), the wrapper provides error handling
      // and retry logic that satisfies the error handling requirements.
      // Evidence: concern-20260401-stripe-1.
      if (detection.packageName === "stripe") {
        // Walk up to find the enclosing call expression in a retry wrapper.
        // Stop at function boundaries so we don't escape the current function scope.
        let cur: ts.Node | undefined = detection.node;
        let inRetryWrapper = false;
        while (cur) {
          if (
            ts.isFunctionDeclaration(cur) ||
            ts.isFunctionExpression(cur) ||
            ts.isArrowFunction(cur) ||
            ts.isMethodDeclaration(cur)
          ) {
            // Check if this function is itself an argument to a retry call
            const funcParent = cur.parent;
            if (funcParent && ts.isCallExpression(funcParent)) {
              const callee = funcParent.expression;
              const calleeName = ts.isIdentifier(callee)
                ? callee.text
                : ts.isPropertyAccessExpression(callee)
                  ? callee.name.text
                  : "";
              if (/retry|backoff|Retry|Backoff/i.test(calleeName)) {
                inRetryWrapper = true;
              }
            }
            break;
          }
          cur = cur.parent;
        }
        if (inRetryWrapper) {
          // WAVE-2F: stripe call inside a retry/backoff wrapper (pRetry,
          // withRetry, retryWithBackoff, etc.) — wrapper handles error and
          // retry logic.
          trace.record(
            MATCHER_IDS.SUPPRESSION_RETRY_WRAPPER,
            "passed",
            "stripe call inside retry/backoff wrapper — wrapper handles errors",
          );
          continue;
        }
      }

      // dayjs(): suppress dayjs-invalid-date when the call has zero arguments.
      // dayjs() with no arguments always returns the current time and is always valid —
      // there is no user-supplied input to validate, so requiring .isValid() is a false positive.
      // dayjs("someString") with an argument still needs validation (may produce Invalid Date).
      // Evidence: concern-20260421-dayjs-no-args-fp — 195 FPs across ant-design (85),
      //   mantine (55), and notesnook (55) from bulk-scan-audit 2026-04-21.
      if (
        detection.packageName === "dayjs" &&
        detection.functionName === "dayjs" &&
        primaryPostcondition.id === "dayjs-invalid-date" &&
        ts.isCallExpression(detection.node) &&
        detection.node.arguments.length === 0
      ) {
        // WAVE-2F: dayjs() with no args always returns current time — no
        // user input to validate, so .isValid() is irrelevant.
        trace.record(
          MATCHER_IDS.SUPPRESSION_NEVER_THROWS,
          "passed",
          "dayjs() with zero args — always returns current time, never invalid",
        );
        continue;
      }

      // dayjs: toISOString() genuinely throws on invalid dates, but in practice it's
      // nearly always called on programmatically-constructed dayjs objects where the input
      // is known-valid. The scanner cannot determine dayjs object validity at compile time,
      // producing near-100% FP rate. Suppress entirely.
      // Evidence: civitai audit 2026-05-05 — 2 remaining FPs after YAML fix.
      if (
        detection.packageName === "dayjs" &&
        primaryPostcondition.id === "toisostring-invalid-date-throws"
      ) {
        // WAVE-2F: toISOString() invalid-date throws cannot be statically
        // determined; near-100% FP rate when fired.
        trace.record(
          MATCHER_IDS.SUPPRESSION_NEVER_THROWS,
          "passed",
          "dayjs toISOString() — invalid-date status not statically determinable",
        );
        continue;
      }

      // react-hook-form useFieldArray: unhandled-field-array-operations fires even when
      // the parent form already has submit error handling. When the component uses
      // handleSubmit (indicating form-level error handling exists), the individual
      // field array mutation calls do not require separate try-catch blocks.
      // Also suppress when the file uses React Hook Form's formState.errors pattern
      // (declarative error handling via form state, not try-catch).
      // Evidence: concern-20260401-react-hook-form-4.
      //           concern-2026-04-11-react-hook-form-19 — 2 FPs: profile-form.tsx.
      // WAVE-2B: file-level handleSubmit / formState / useForm presence indicates
      // form-level error handling — record FRAMEWORK_REACT_HOOK_FORM passed.
      if (
        detection.packageName === "react-hook-form" &&
        primaryPostcondition.id === "unhandled-field-array-operations" &&
        (sourceFile.getFullText().includes("handleSubmit") ||
          sourceFile.getFullText().includes("formState") ||
          sourceFile.getFullText().includes("useForm(") ||
          sourceFile.getFullText().includes("useForm<"))
      ) {
        trace.record(MATCHER_IDS.FRAMEWORK_REACT_HOOK_FORM, "passed");
        this.recordPassedSite(
          detection,
          sourceFile,
          primaryPostcondition.id,
          MATCHER_IDS.FRAMEWORK_REACT_HOOK_FORM,
        );
        continue;
      }

      // @tanstack/react-query: refetchQueries and prefetchQuery never throw by design.
      // refetchqueries-silent-failure postcondition is self-contradictory — it documents
      // throwOnError:false (no throw) but the description claims crash risk. The postcondition
      // misrepresents the API's actual behavior. refetchQueries errors go into query state.
      // prefetchquery-silently-swallows-errors: prefetchQuery intentionally never throws —
      // errors are silently discarded as the designed cache-warming pattern. Fire-and-forget
      // is correct usage. try-catch around these calls is dead code.
      // Evidence: concern-20260712-lead-24-tanstack-query-family-hooks-reconfirmation
      //           (2 refetchqueries-silent-failure FPs in vendure-dashboard, scira-firecrawl;
      //            5 prefetchquery-silently-swallows-errors FPs in supabase-studio;
      //            all labeled C=FP with high confidence by wave 5 adjudicators).
      // WAVE-2B: unconditional — these postconditions have near-100% FP rate.
      if (
        detection.packageName === "@tanstack/react-query" &&
        (primaryPostcondition.id === "refetchqueries-silent-failure" ||
          primaryPostcondition.id === "prefetchquery-silently-swallows-errors")
      ) {
        trace.record(MATCHER_IDS.FRAMEWORK_REACT_QUERY, "passed");
        this.recordPassedSite(
          detection,
          sourceFile,
          primaryPostcondition.id,
          MATCHER_IDS.FRAMEWORK_REACT_QUERY,
        );
        continue;
      }

      // @tanstack/react-query: error postconditions fire as FPs in three patterns:
      //   1. Custom hook files (useXxx.ts) — wrappers that return {data, error, isError};
      //      error handling is the caller's responsibility.
      //   2. Component files where the file destructures/uses .error or isError from the
      //      hook result — React Query's idiomatic error-state pattern (not try-catch).
      //   3. Projects with a global QueryCache/MutationCache onError handler, top-level
      //      ErrorBoundary, or central error handler module — wiring is cross-file so the
      //      per-file isError/onError check above does not catch it.
      //
      // Evidence: concern-2026-04-02-tanstack-react-query-query-error-unhandled-5 (18 FPs hooks),
      //           concern-2026-04-02-tanstack-react-query-infinite-query-error-unhandled-11 (3 FPs),
      //           concern-2026-04-02-tanstack-react-query-mutation-error-unhandled-18 (2 FPs),
      //           concern-2026-04-02-dashboard-tanstack-react-query-1 (25 FPs in component files:
      //           app/access/page.tsx, components/Agents/AgentCreator.tsx, etc.).
      //           concern-20260515-section3-gap-1-querycache-onerror (~564 FPs estimate;
      //           rank-12 openstatus 269/269 FPs, rank-06 chatbox 26/26 FPs, rank-08 sealos).
      //           concern-20260515-section3-gap-2-fetchquery-postconditions (1 retro;
      //           queryClient.fetchQuery in auth/providers.ts at rank-12 openstatus).
      // WAVE-2B: each of the three react-query short-circuits below is a
      // framework-idiomatic error-handling pattern — record FRAMEWORK_REACT_QUERY
      // passed for each.
      if (
        detection.packageName === "@tanstack/react-query" &&
        (primaryPostcondition.id === "query-error-unhandled" ||
          primaryPostcondition.id === "infinite-query-error-unhandled" ||
          primaryPostcondition.id === "mutation-error-unhandled" ||
          primaryPostcondition.id === "stale-query-refetch-error" ||
          primaryPostcondition.id === "mutation-optimistic-update-rollback" ||
          primaryPostcondition.id === "fetchquery-throws-on-error" ||
          primaryPostcondition.id === "fetchquery-ssr-uncaught-error")
      ) {
        const fileText = sourceFile.getFullText();
        // Custom hook files delegate error handling to callers
        const baseName = path.basename(
          sourceFile.fileName.replace(/\.tsx?$/, ""),
        );
        const recordPassedRq = (): void => {
          trace.record(MATCHER_IDS.FRAMEWORK_REACT_QUERY, "passed");
          this.recordPassedSite(
            detection,
            sourceFile,
            primaryPostcondition.id,
            MATCHER_IDS.FRAMEWORK_REACT_QUERY,
          );
        };
        if (/^use[A-Z]/.test(baseName)) {
          recordPassedRq();
          continue; // Hook wrapper file — caller's responsibility
        }
        // Component files using React Query's error state pattern (isError, error property).
        // Only applies to query/infinite-query postconditions (useQuery error state API).
        // mutation-error-unhandled FPs are covered by the hook-file check above (useXxx pattern).
        // fetchquery-* runs OUTSIDE component render (e.g. SSR loaders, auth callbacks) —
        // the .error / isError per-file pattern doesn't apply to those call sites.
        // Note: we avoid ".error" (matches console.error) and "error)" (matches error handling).
        // Only match unambiguous RQ error state destructuring patterns.
        const isComponentFilePattern =
          primaryPostcondition.id === "query-error-unhandled" ||
          primaryPostcondition.id === "infinite-query-error-unhandled" ||
          primaryPostcondition.id === "stale-query-refetch-error" ||
          primaryPostcondition.id === "mutation-optimistic-update-rollback";
        if (
          isComponentFilePattern &&
          (fileText.includes("isError") ||
            fileText.includes("{ error") ||
            fileText.includes("error }") ||
            fileText.includes("onError"))
        ) {
          recordPassedRq();
          continue; // Error handled via React Query state API, not try-catch
        }
        // Project-level signal — applies to ALL five gated postconditions.
        // A global QueryCache(onError) / MutationCache(onError) / top-level ErrorBoundary /
        // central error handler module satisfies the postcondition cross-file.
        if (this.projectHasReactQueryGlobalErrorHandler()) {
          recordPassedRq();
          continue;
        }
      }

      // ai (Vercel AI SDK): api-error-rate-limit fires even when the AI call is inside
      // a function that is itself wrapped in a retry mechanism. When the immediate enclosing
      // function is passed as an argument to a retry utility (pRetry, withRetry, retry, etc.),
      // the retry wrapper provides rate-limit handling that satisfies the postcondition.
      // This mirrors the stripe retry-wrapper suppression.
      //
      // Evidence: concern-2026-04-02-ai-api-error-rate-limit-7 (6 FPs across eval files and
      //           utility functions where retry logic lives at the call site, not inside).
      if (
        detection.packageName === "ai" &&
        primaryPostcondition.id === "api-error-rate-limit"
      ) {
        let cur: ts.Node | undefined = detection.node;
        let inRetryWrapper = false;
        while (cur) {
          if (
            ts.isFunctionDeclaration(cur) ||
            ts.isFunctionExpression(cur) ||
            ts.isArrowFunction(cur) ||
            ts.isMethodDeclaration(cur)
          ) {
            // Check if this function is itself an argument to a retry call
            const funcParent = cur.parent;
            if (funcParent && ts.isCallExpression(funcParent)) {
              const callee = funcParent.expression;
              const calleeName = ts.isIdentifier(callee)
                ? callee.text
                : ts.isPropertyAccessExpression(callee)
                  ? callee.name.text
                  : "";
              if (/retry|backoff|Retry|Backoff/i.test(calleeName)) {
                inRetryWrapper = true;
              }
            }
            break;
          }
          cur = cur.parent;
        }
        if (inRetryWrapper) {
          // WAVE-2F: ai call inside a retry/backoff wrapper — wrapper handles
          // rate limits and retry logic.
          trace.record(
            MATCHER_IDS.SUPPRESSION_RETRY_WRAPPER,
            "passed",
            "ai call inside retry/backoff wrapper — wrapper handles rate limits",
          );
          continue;
        }
      }

      // ai (Vercel AI SDK): tool-execution-error fires on ai.tool() calls even though
      // tool() is a factory function that creates tool definitions — it never throws itself.
      // The execute callback's errors are managed by the AI SDK framework at generateText()
      // invocation time (not at tool definition time), so try-catch around tool() is meaningless.
      // Suppress tool-execution-error for all ai.tool() calls unconditionally.
      //
      // Evidence: concern-2026-04-02-ai-2 (25 FP instances across AI tool implementations).
      if (
        detection.packageName === "ai" &&
        detection.functionName === "tool" &&
        primaryPostcondition.id === "tool-execution-error"
      ) {
        // WAVE-2F: ai.tool() factory does not throw — execute callback runs
        // at generateText() time, not at definition time.
        trace.record(
          MATCHER_IDS.SUPPRESSION_FACTORY_FUNCTION,
          "passed",
          "ai.tool() factory — execute callback runs at generateText() time",
        );
        continue;
      }

      // xml2js parseString: parse-string-callback-error-ignored fires on ALL parseString
      // calls, including ones where the callback DOES check the err parameter. The
      // standard try-catch analysis does not apply to callback-style APIs.
      //
      // Suppress when: the last argument to parseString() is a function whose first
      // parameter is referenced in an if-check (i.e., `if (err)`) within the callback body.
      //
      // Works for both throwing-function detection (node = CallExpression) and
      // error-first-callback detection (node = ArrowFunction/FunctionExpression).
      //
      // Evidence: concern-20260417-xml2js-deepen-1 ground-truth test (line 82 FP:
      // parseString(xml, (err, result) => { if (err) { return; } ... }) fires incorrectly).
      if (
        detection.packageName === "xml2js" &&
        detection.functionName === "parseString" &&
        primaryPostcondition.id === "parse-string-callback-error-ignored"
      ) {
        // Resolve the callback node: either the detection.node itself (error-first-callback),
        // or the last function-like argument of the CallExpression (throwing-function).
        let cbNode: ts.Node = detection.node;
        if (
          !ts.isArrowFunction(cbNode) &&
          !ts.isFunctionExpression(cbNode) &&
          ts.isCallExpression(detection.node)
        ) {
          const args = detection.node.arguments;
          for (let i = args.length - 1; i >= 0; i--) {
            if (ts.isArrowFunction(args[i]) || ts.isFunctionExpression(args[i])) {
              cbNode = args[i];
              break;
            }
          }
        }
        if (ts.isArrowFunction(cbNode) || ts.isFunctionExpression(cbNode)) {
          const func = cbNode as ts.ArrowFunction | ts.FunctionExpression;
          const errParamName =
            func.parameters.length > 0 && ts.isIdentifier(func.parameters[0].name)
              ? func.parameters[0].name.text
              : null;
          if (errParamName) {
            let errIsChecked = false;
            const walkForErrCheck = (n: ts.Node): void => {
              if (errIsChecked) return;
              // Match: if (err) {...} or if (err !== null) {...} or if (err != null) {...}
              if (ts.isIfStatement(n)) {
                const condText = n.expression.getText(sourceFile);
                if (
                  condText === errParamName ||
                  condText.startsWith(errParamName + " ") ||
                  condText.startsWith(errParamName + "!") ||
                  condText.startsWith(errParamName + ")")
                ) {
                  errIsChecked = true;
                  return;
                }
              }
              ts.forEachChild(n, walkForErrCheck);
            };
            if (func.body) walkForErrCheck(func.body);
            if (errIsChecked) {
              // WAVE-2F: xml2js parseString callback explicitly checks the
              // err parameter — callback-style error handling satisfied.
              trace.record(
                MATCHER_IDS.SUPPRESSION_CALLBACK_ERR_CHECKED,
                "passed",
                "parseString callback explicitly checks err parameter",
              );
              continue;
            }
          }
        }
      }

      // xml2js Parser.parseString (instance method, callback form): parallel suppression to the
      // module-level parseString check above. After the Parser.parseString rerouting above,
      // effectiveFunctionName is 'Parser.parseString' for parser.parseString() calls, and the
      // primary postcondition is parser-instance-parse-string-callback-error-ignored.
      //
      // The same callback-err-check logic applies: suppress when the callback's first parameter
      // is explicitly checked in an if-statement inside the callback body.
      //
      // Evidence: concern-20260630-xml2js-instance-disambiguation-1 — ground-truth lines 189, 197
      // (parser.parseString with callbacks that ignore err should fire
      // parser-instance-parse-string-callback-error-ignored; parser.parseString with callbacks
      // that check err should SHOULD_NOT_FIRE).
      if (
        detection.packageName === "xml2js" &&
        effectiveFunctionName === "Parser.parseString" &&
        primaryPostcondition.id === "parser-instance-parse-string-callback-error-ignored"
      ) {
        // Resolve the callback node: either the detection.node itself (error-first-callback),
        // or the last function-like argument of the CallExpression (throwing-function).
        let cbNode: ts.Node = detection.node;
        if (
          !ts.isArrowFunction(cbNode) &&
          !ts.isFunctionExpression(cbNode) &&
          ts.isCallExpression(detection.node)
        ) {
          const args = detection.node.arguments;
          for (let i = args.length - 1; i >= 0; i--) {
            if (ts.isArrowFunction(args[i]) || ts.isFunctionExpression(args[i])) {
              cbNode = args[i];
              break;
            }
          }
        }
        if (ts.isArrowFunction(cbNode) || ts.isFunctionExpression(cbNode)) {
          const func = cbNode as ts.ArrowFunction | ts.FunctionExpression;
          const errParamName =
            func.parameters.length > 0 && ts.isIdentifier(func.parameters[0].name)
              ? func.parameters[0].name.text
              : null;
          if (errParamName) {
            let errIsChecked = false;
            const walkForErrCheck = (n: ts.Node): void => {
              if (errIsChecked) return;
              // Match: if (err) {...} or if (err !== null) {...} or if (err != null) {...}
              if (ts.isIfStatement(n)) {
                const condText = n.expression.getText(sourceFile);
                if (
                  condText === errParamName ||
                  condText.startsWith(errParamName + " ") ||
                  condText.startsWith(errParamName + "!") ||
                  condText.startsWith(errParamName + ")")
                ) {
                  errIsChecked = true;
                  return;
                }
              }
              ts.forEachChild(n, walkForErrCheck);
            };
            if (func.body) walkForErrCheck(func.body);
            if (errIsChecked) {
              // WAVE-2F: xml2js Parser.parseString instance callback explicitly checks
              // the err parameter — callback-style error handling satisfied.
              trace.record(
                MATCHER_IDS.SUPPRESSION_CALLBACK_ERR_CHECKED,
                "passed",
                "Parser.parseString instance callback explicitly checks err parameter",
              );
              continue;
            }
          }
        }
      }

      // xml2js parseStringPromise: null-return handling for module-level calls.
      // parseStringPromise() can either (a) reject with Error on malformed XML (parse-error-malformed-xml)
      // or (b) resolve with null on empty/whitespace input (parse-promise-null-return).
      // These are independent failure modes. When the caller DOES null-check the result, they are
      // correctly handling the (b) case. Suppress the violation entirely for callers that null-guard.
      // When the caller does NOT null-check and accesses result.prop directly, fire parse-promise-null-return.
      //
      // This path only applies to module-level parseStringPromise calls (not Parser instances, which
      // are routed to Parser.parseStringPromise / parser-instance-malformed-xml above).
      //
      // Evidence: concern-20260417-xml2js-deepen-2 ground-truth test (lines 156/165:
      //   line 156 null-checks result → SHOULD_NOT_FIRE; line 165 no null-check → SHOULD_FIRE: parse-promise-null-return).
      if (
        detection.packageName === "xml2js" &&
        effectiveFunctionName === "parseStringPromise" &&
        postconditions.some((p) => p.id === "parse-promise-null-return")
      ) {
        const nullPostcondition = postconditions.find(
          (p) => p.id === "parse-promise-null-return",
        );
        if (nullPostcondition) {
          if (this.controlFlow.isResultExplicitlyNullGuarded(detection.node)) {
            // Result has an explicit null guard (if (result == null)): suppress violation entirely.
            // The caller is correctly handling the empty-input case.
            // WAVE-2F: explicit null guard satisfies parse-promise-null-return.
            trace.record(
              MATCHER_IDS.SUPPRESSION_NULL_GUARDED,
              "passed",
              "parseStringPromise result explicitly null-checked",
            );
            continue;
          }
          // If the result is null-guarded (no non-optional property access), fall through to
          // standard try-catch analysis (parse-error-malformed-xml path).
          if (!this.controlFlow.isResultNullGuarded(detection.node)) {
            // Not null-guarded: result accessed without null check → fire parse-promise-null-return
            // (skip standard try-catch analysis for this detection)
            // WAVE-2F: record SUPPRESSION_NULL_GUARDED as failed so the
            // violation trace shows the matcher WAS considered (the result
            // was not null-guarded — that's the reason this violation fires).
            trace.record(
              MATCHER_IDS.SUPPRESSION_NULL_GUARDED,
              "failed",
              "parseStringPromise result accessed without null check",
            );
            const { line, column } = this.getLocation(detection.node, sourceFile);
            const { json: codeContext, startLine: codeContextStartLine } =
              this.buildCodeContext(sourceFile, line - 1);
            const fingerprint = computeViolationFingerprint({
              packageName: detection.packageName,
              postconditionId: nullPostcondition.id,
              filePath: sourceFile.fileName,
              lineNumber: line,
              callExpression: detection.functionName,
            });
            const suppressionResult = checkSuppression({
              projectRoot: this.options.projectRoot,
              sourceFile,
              line,
              column,
              packageName: detection.packageName,
              postconditionId: nullPostcondition.id,
              analyzerVersion: this.options.analyzerVersion || "2.0.0",
              updateManifest: false,
              fingerprint,
            });
            if (!suppressionResult.suppressed) {
              violations.push({
                file: sourceFile.fileName,
                line,
                column,
                package: detection.packageName,
                function: detection.functionName,
                postconditionId: nullPostcondition.id,
                severity: nullPostcondition.severity as "error" | "warning",
                message: `parseStringPromise() resolves with null on empty input — caller must null-check the result before accessing properties`,
                codeContext,
                codeContextStartLine,
                inTryCatch: false,
                suppressed: false,
                fingerprint,
                callExpression: detection.functionName,
                business_impact: nullPostcondition.business_impact,
                // WAVE-2F: violation pushed at custom firing path also carries
                // the per-callsite detectionTrace (matches the canonical
                // violation construction at line ~3656).
                detectionTrace: trace.serialize(),
              });
            }
            continue;
          }
        }
      }

      // next-auth: signIn() from next-auth/react is a client-side browser redirect, not
      // an async I/O operation. Default signIn() navigates the browser — there's no error
      // to handle unless { redirect: false } is explicitly passed. Suppress unless redirect: false.
      // Evidence: civitai audit 2026-05-05 — 3 FPs (AccountProvider.tsx, auth-helpers.ts, etc.)
      if (
        detection.packageName === "next-auth" &&
        detection.functionName === "signIn" &&
        primaryPostcondition.id === "signin-error-not-checked"
      ) {
        // Check if the call passes { redirect: false } — only that form needs error checking
        if (ts.isCallExpression(detection.node)) {
          let hasRedirectFalse = false;
          for (const arg of detection.node.arguments) {
            if (ts.isObjectLiteralExpression(arg)) {
              for (const prop of arg.properties) {
                if (
                  ts.isPropertyAssignment(prop) &&
                  ts.isIdentifier(prop.name) &&
                  prop.name.text === "redirect" &&
                  prop.initializer.kind === ts.SyntaxKind.FalseKeyword
                ) {
                  hasRedirectFalse = true;
                }
              }
            }
          }
          if (!hasRedirectFalse) {
            // WAVE-2F: default next-auth signIn() navigates the browser —
            // no async error to catch unless { redirect: false }.
            trace.record(
              MATCHER_IDS.SUPPRESSION_NEVER_THROWS,
              "passed",
              "next-auth signIn() default — browser redirect, no error to catch",
            );
            continue;
          }
        }
      }

      // @supabase/supabase-js auth functions (signUp, signIn, signInWithPassword, etc.):
      // Supabase's auth SDK never throws — it returns { data, error }. When the result is
      // returned directly (return await supabase.auth.signUp(...)), error handling is
      // delegated to the caller. This is a valid wrapper pattern; suppress the violation.
      //
      // The isDestructuredErrorTupleProtected check handles const { error } = await ... patterns.
      // This suppression handles the complementary `return await supabase.auth.METHOD(...)` pattern.
      //
      // Evidence: concern-2026-04-02-supabase-supabase-js-19 (1 FP: auth-context.tsx returns
      //           signUp result directly; caller is responsible for error handling).
      if (detection.packageName === "@supabase/supabase-js") {
        // Walk up from the call node to see if it's directly inside a return statement
        // (stopping at function boundaries and blocks so we don't escape the function scope)
        let cur: ts.Node | undefined = detection.node.parent;
        let isReturnDelegate = false;
        while (cur) {
          if (ts.isReturnStatement(cur)) {
            isReturnDelegate = true;
            break;
          }
          if (
            ts.isBlock(cur) ||
            ts.isArrowFunction(cur) ||
            ts.isFunctionExpression(cur) ||
            ts.isFunctionDeclaration(cur) ||
            ts.isMethodDeclaration(cur)
          ) {
            break;
          }
          cur = cur.parent;
        }
        if (isReturnDelegate) {
          // WAVE-2F: supabase auth call directly returned to caller —
          // error handling delegated.
          trace.record(
            MATCHER_IDS.SUPPRESSION_RETURN_DELEGATE,
            "passed",
            "supabase auth call directly returned to caller — caller handles { error }",
          );
          continue;
        }
      }

      // redux-persist persistor.flush() / .purge() and top-level getStoredState() /
      // purgeStoredState() — bare `return persistor.flush()` (no await) delegates
      // rejection handling to the caller. The contract's required_handling on every
      // postcondition explicitly lists "return the promise" as a valid strategy.
      // See nark-corpus-pro/packages/redux-persist/contract.yaml.
      if (detection.packageName === "redux-persist") {
        const callParent = detection.node.parent;
        if (callParent && ts.isReturnStatement(callParent)) {
          // WAVE-2F: bare `return persistor.flush()` delegates rejection
          // handling to the caller — listed as valid handling in the contract.
          trace.record(
            MATCHER_IDS.SUPPRESSION_RETURN_DELEGATE,
            "passed",
            "redux-persist call is bare-returned — caller handles rejection",
          );
          continue;
        }
      }

      // jsonwebtoken jwt.decode() security postconditions:
      //
      // decode-used-for-authentication: jwt.decode() does NOT verify the token signature —
      // using its return value for auth/authz decisions without subsequently calling
      // jwt.verify() is a complete authentication bypass (OWASP documented).
      // Suppress when the file also calls jwt.verify() — it indicates the decode() is
      // used for a legitimate purpose (header inspection for JWKS key selection or
      // post-verify metadata extraction) and verify() handles the security check.
      //
      // decode-null-return-not-checked: handled by the requiresNullCheck path below
      // (postcondition id contains "null") — isResultNullGuarded() catches null guards.
      //
      // Evidence: concern-2026-04-02-jsonwebtoken-deepen-1 (decode-used-for-authentication)
      if (
        detection.packageName === "jsonwebtoken" &&
        detection.functionName === "decode" &&
        primaryPostcondition.id === "decode-used-for-authentication"
      ) {
        // Suppress when the enclosing function also calls verify() — two legitimate patterns:
        // 1. decode() reads the header.kid to select a JWKS key, then verify() is called
        // 2. verify() is called first, then decode() is used for metadata extraction
        // Both are safe because verify() handles the cryptographic check.
        // We check the ENCLOSING FUNCTION (not the whole file) to avoid suppressing calls
        // in different functions that happen to share the same file.
        let enclosingFunction: ts.Node | undefined;
        let cur: ts.Node | undefined = detection.node.parent;
        while (cur) {
          if (
            ts.isFunctionDeclaration(cur) ||
            ts.isFunctionExpression(cur) ||
            ts.isArrowFunction(cur) ||
            ts.isMethodDeclaration(cur)
          ) {
            enclosingFunction = cur;
            break;
          }
          cur = cur.parent;
        }
        // Check if the enclosing function (or the whole file if no function found) calls verify()
        const scopeToCheck = enclosingFunction ?? sourceFile;
        let hasVerifyCall = false;
        const checkForVerify = (node: ts.Node): void => {
          if (
            ts.isCallExpression(node) &&
            ts.isPropertyAccessExpression(node.expression) &&
            node.expression.name.text === "verify"
          ) {
            hasVerifyCall = true;
            return;
          }
          if (!hasVerifyCall) {
            ts.forEachChild(node, checkForVerify);
          }
        };
        checkForVerify(scopeToCheck);
        if (hasVerifyCall) {
          // WAVE-2F: jwt.decode() inside an enclosing scope that also calls
          // jwt.verify() — verify() handles the cryptographic check.
          trace.record(
            MATCHER_IDS.SUPPRESSION_PROJECT_ARCHITECTURE,
            "passed",
            "jwt.decode() paired with jwt.verify() in enclosing scope",
          );
          continue;
        }
        // Fire violation — no verify() in file, decode() is being used for auth decisions
        // Fall through to violation generation (skip try-catch analysis — decode() never throws)
        // WAVE-2F: record SUPPRESSION_PROJECT_ARCHITECTURE as failed so the
        // violation trace surfaces the missing verify() pairing.
        trace.record(
          MATCHER_IDS.SUPPRESSION_PROJECT_ARCHITECTURE,
          "failed",
          "jwt.decode() has no paired jwt.verify() in enclosing scope",
        );
        const { line, column } = this.getLocation(detection.node, sourceFile);
        const { json: codeContext, startLine: codeContextStartLine } =
          this.buildCodeContext(sourceFile, line - 1);
        const fingerprint = computeViolationFingerprint({
          packageName: detection.packageName,
          postconditionId: primaryPostcondition.id,
          filePath: sourceFile.fileName,
          lineNumber: line,
          callExpression: detection.functionName,
        });
        const suppressionResult = checkSuppression({
          projectRoot: this.options.projectRoot,
          sourceFile,
          line,
          column,
          packageName: detection.packageName,
          postconditionId: primaryPostcondition.id,
          analyzerVersion: this.options.analyzerVersion || "2.0.0",
          updateManifest: false,
          fingerprint,
        });
        if (!suppressionResult.suppressed) {
          violations.push({
            file: sourceFile.fileName,
            line,
            column,
            package: detection.packageName,
            function: detection.functionName,
            postconditionId: primaryPostcondition.id,
            severity: primaryPostcondition.severity as "error" | "warning",
            message: `jwt.decode() return value used without jwt.verify() — decode() does not verify the token signature; attacker can forge any claim (isAdmin: true, userId: 999) and decode() will return the tampered values without detection`,
            codeContext,
            codeContextStartLine,
            inTryCatch: false,
            suppressed: false,
            fingerprint,
            callExpression: detection.functionName,
            business_impact: primaryPostcondition.business_impact,
            // WAVE-2F: custom-firing path also serializes the trace so the
            // violation surface stays consistent with the canonical path.
            detectionTrace: trace.serialize(),
          });
        }
        continue;
      }

      // got: suppress all violations when 'got' is not imported in the file.
      // Zod's schema.extend() method (and any other package's .extend() method) collide
      // with got.extend() detection because the ThrowingFunctionDetector matches .extend()
      // by method name without verifying the receiver's import. In botpress all 22 got
      // violations were Zod calls — no `got` import anywhere in those files.
      // Fix: check that the file actually imports from "got" or "got/<subpath>" before
      // firing any got contract violation.
      // Evidence: concern-20260421-got-zod-extend-collision (22 FPs in botpress/botpress).
      if (detection.packageName === "got") {
        const hasGotImport = sourceFile.statements.some(
          (stmt) =>
            ts.isImportDeclaration(stmt) &&
            ts.isStringLiteral(stmt.moduleSpecifier) &&
            (stmt.moduleSpecifier.text === "got" ||
              stmt.moduleSpecifier.text.startsWith("got/")),
        );
        if (!hasGotImport) {
          // WAVE-2F: got is not imported in this file — .extend() is a
          // name-collision with Zod or another package; not a real got call.
          trace.record(
            MATCHER_IDS.SUPPRESSION_PACKAGE_NOT_IMPORTED,
            "passed",
            "got package not imported in this file — detection is a name-collision",
          );
          continue;
        }
      }

      // ──────────────────────────────────────────────────────────────────────────
      // @sentry/* special-case postconditions
      // ──────────────────────────────────────────────────────────────────────────

      // @sentry/* withMonitor: monitor-slug-not-configured fires when the 3rd argument
      // (upsertMonitorConfig) is missing — regardless of whether the call is in try-catch.
      // The check-in is silently dropped if the monitor slug doesn't exist in Sentry.
      // This is INDEPENDENT of the monitor-callback-rethrows try-catch check.
      // Evidence: concern-20260611-sentry-node-deepen-3
      if (
        detection.packageName.startsWith("@sentry/") &&
        detection.functionName === "withMonitor" &&
        ts.isCallExpression(detection.node)
      ) {
        const monitorSlugPc = postconditions.find(
          (p) => p.id === "monitor-slug-not-configured",
        );
        if (monitorSlugPc && detection.node.arguments.length < 3) {
          // Arg count < 3 — upsertMonitorConfig missing: fire monitor-slug-not-configured
          // WAVE-2F: record the missing upsertMonitorConfig argument as a
          // failed check so the violation trace carries meaningful signal.
          trace.record(
            MATCHER_IDS.SUPPRESSION_OPTION_SUPPRESSES,
            "failed",
            "withMonitor() missing 3rd argument (upsertMonitorConfig) — slug auto-creation disabled",
          );
          const { line: mLine, column: mCol } = this.getLocation(
            detection.node,
            sourceFile,
          );
          const { json: mCtx, startLine: mCtxStart } = this.buildCodeContext(
            sourceFile,
            mLine - 1,
          );
          const mFingerprint = computeViolationFingerprint({
            packageName: detection.packageName,
            postconditionId: monitorSlugPc.id,
            filePath: sourceFile.fileName,
            lineNumber: mLine,
            callExpression: detection.functionName,
          });
          const mSuppression = checkSuppression({
            projectRoot: this.options.projectRoot,
            sourceFile,
            line: mLine,
            column: mCol,
            packageName: detection.packageName,
            postconditionId: monitorSlugPc.id,
            analyzerVersion: this.options.analyzerVersion || "2.0.0",
            updateManifest: false,
            fingerprint: mFingerprint,
          });
          violations.push({
            file: sourceFile.fileName,
            line: mLine,
            column: mCol,
            package: detection.packageName,
            function: detection.functionName,
            postconditionId: monitorSlugPc.id,
            severity: monitorSlugPc.severity as "error" | "warning",
            message: `withMonitor() called without upsertMonitorConfig (3rd argument) — if the monitor slug does not exist in Sentry, check-ins are silently ignored and no cron alert will fire.`,
            codeContext: mCtx,
            codeContextStartLine: mCtxStart,
            inTryCatch: false,
            suppressed: mSuppression.suppressed,
            suppressionReason: mSuppression.suppressed
              ? mSuppression.source
              : undefined,
            fingerprint: mFingerprint,
            callExpression: detection.functionName,
            business_impact: monitorSlugPc.business_impact,
            // WAVE-2F: serialize the trace snapshot at slug-violation push
            // time so the surfaced violation carries detectionTrace. The
            // canonical OR-chain at the end of the loop body will continue
            // recording matchers for the monitor-callback-rethrows violation
            // (if it also fires) — those records appear in a separate
            // violation's serialized trace.
            detectionTrace: trace.serialize(),
          });
        }
        // Fall through to standard try-catch check for monitor-callback-rethrows
      }

      // @sentry/* startSpanManual: span-manual-finish-never-called fires when the callback
      // does not contain a try/finally that calls finish() or span.end() in all paths.
      // Unlike span-manual-callback-rethrows (try-catch around the call), this postcondition
      // requires a finally block INSIDE the callback to guarantee span lifecycle.
      // Suppress when the callback has try { ... } finally { finish() } or
      // try { ... } finally { span.end() } pattern.
      // Evidence: concern-20260611-sentry-node-deepen-1
      if (
        detection.packageName.startsWith("@sentry/") &&
        detection.functionName === "startSpanManual" &&
        ts.isCallExpression(detection.node) &&
        primaryPostcondition.id === "span-manual-finish-never-called"
      ) {
        // Find the callback argument (usually last arg, either arrow or function expression)
        const callbackArg = detection.node.arguments
          .slice()
          .reverse()
          .find(
            (a): a is ts.ArrowFunction | ts.FunctionExpression =>
              ts.isArrowFunction(a) || ts.isFunctionExpression(a),
          );
        if (callbackArg && ts.isBlock(callbackArg.body)) {
          // Check if callback body contains a try statement with a finally block
          // that calls finish() or span.end()
          let hasFinishInFinally = false;
          const checkForFinishInFinally = (node: ts.Node): void => {
            if (hasFinishInFinally) return;
            if (
              ts.isTryStatement(node) &&
              node.finallyBlock
            ) {
              // Walk the finally block looking for finish() or .end() calls
              const searchFinally = (n: ts.Node): void => {
                if (hasFinishInFinally) return;
                if (ts.isCallExpression(n)) {
                  // finish() — direct identifier call
                  if (ts.isIdentifier(n.expression) && n.expression.text === "finish") {
                    hasFinishInFinally = true;
                    return;
                  }
                  // span.end() — property access ending in .end()
                  if (
                    ts.isPropertyAccessExpression(n.expression) &&
                    n.expression.name.text === "end"
                  ) {
                    hasFinishInFinally = true;
                    return;
                  }
                }
                ts.forEachChild(n, searchFinally);
              };
              searchFinally(node.finallyBlock);
              return;
            }
            ts.forEachChild(node, checkForFinishInFinally);
          };
          checkForFinishInFinally(callbackArg.body);
          if (hasFinishInFinally) {
            // WAVE-2E: sentry startSpanManual try/finally { finish() | span.end() }
            // pattern detected — record FINALLY_SPAN_END as passed and capture the
            // site for the Wave 9 convention miner. Gate inside recordPassedSite
            // checks PASSING_SITE_PACKAGES membership.
            trace.record(MATCHER_IDS.FINALLY_SPAN_END, "passed");
            this.recordPassedSite(
              detection,
              sourceFile,
              primaryPostcondition.id,
              MATCHER_IDS.FINALLY_SPAN_END,
            );
            continue; // Callback has try/finally with finish() or span.end() — postcondition satisfied
          }
        }
        // WAVE-2E: callback lacks try/finally with finish/end — record
        // FINALLY_SPAN_END as failed so the violation's detectionTrace shows
        // the matcher WAS considered (not `not_applicable`). This is the
        // PH1-R2b acceptance shape: try-catch family is not_applicable AND
        // finally:span-end is failed.
        trace.record(
          MATCHER_IDS.FINALLY_SPAN_END,
          "failed",
          "no try/finally with finish() or span.end() in startSpanManual callback",
        );
        // Callback lacks try/finally with finish/end: fall through to fire violation
        // (bypass the standard outer try-catch check — the required pattern is INSIDE the callback)
      }

      // @sentry/* startInactiveSpan: inactive-span-end-never-called fires when the returned
      // span does not have span.end() called in a finally block within the enclosing function.
      // The pattern requires: const span = startInactiveSpan(...); try { ... } finally { span.end(); }
      // Suppress when the enclosing function has a try/finally that calls .end() on any variable.
      // Evidence: concern-20260611-sentry-node-deepen-2
      if (
        detection.packageName.startsWith("@sentry/") &&
        detection.functionName === "startInactiveSpan" &&
        ts.isCallExpression(detection.node) &&
        primaryPostcondition.id === "inactive-span-end-never-called"
      ) {
        // Walk up to find the enclosing function
        let enclosingFunc: ts.Node | undefined;
        let curNode: ts.Node | undefined = detection.node.parent;
        while (curNode) {
          if (
            ts.isFunctionDeclaration(curNode) ||
            ts.isFunctionExpression(curNode) ||
            ts.isArrowFunction(curNode) ||
            ts.isMethodDeclaration(curNode)
          ) {
            enclosingFunc = curNode;
            break;
          }
          curNode = curNode.parent;
        }
        const scopeNode = enclosingFunc ?? sourceFile;
        // Check if the scope contains a try/finally that calls .end() anywhere in the finally
        let hasEndInFinally = false;
        const checkForEndInFinally = (node: ts.Node): void => {
          if (hasEndInFinally) return;
          if (
            ts.isBlock(node) &&
            node.parent &&
            ts.isTryStatement(node.parent) &&
            node.parent.finallyBlock === node
          ) {
            // This block is a finally clause — check for .end() call
            const findEnd = (n: ts.Node): void => {
              if (hasEndInFinally) return;
              if (
                ts.isCallExpression(n) &&
                ts.isPropertyAccessExpression(n.expression) &&
                n.expression.name.text === "end"
              ) {
                hasEndInFinally = true;
                return;
              }
              ts.forEachChild(n, findEnd);
            };
            findEnd(node);
            return;
          }
          ts.forEachChild(node, checkForEndInFinally);
        };
        checkForEndInFinally(scopeNode);
        if (hasEndInFinally) {
          // WAVE-2E: sentry startInactiveSpan enclosing-function try/finally
          // { span.end() } pattern detected — record FINALLY_SPAN_END as passed
          // and capture the site for the Wave 9 convention miner.
          trace.record(MATCHER_IDS.FINALLY_SPAN_END, "passed");
          this.recordPassedSite(
            detection,
            sourceFile,
            primaryPostcondition.id,
            MATCHER_IDS.FINALLY_SPAN_END,
          );
          continue; // try/finally { span.end() } present — postcondition satisfied
        }
        // WAVE-2E: no try/finally with end() in enclosing function — record
        // FINALLY_SPAN_END as failed so the violation's detectionTrace shows
        // the matcher WAS considered (not `not_applicable`).
        trace.record(
          MATCHER_IDS.FINALLY_SPAN_END,
          "failed",
          "no try/finally with span.end() in enclosing function",
        );
        // No try/finally with end(): fall through to fire violation
        // (skip standard outer try-catch check — the pattern requires finally, not catch)
      }

      // @nestjs/axios Observable error-channel patterns.
      //
      // HttpService verb methods (get/post/put/patch/delete/head/request/postForm/putForm/patchForm)
      // return Observable<AxiosResponse> — NOT a Promise. The standard try-catch analysis fires
      // on the httpService.X(url) call site even when the Observable IS handled via two valid
      // RxJS-aware patterns that the standard check does not recognize:
      //
      //   (2) .pipe(catchError(handler))  — Observable error intercepted before it propagates
      //   (3) .subscribe({ error: handler }) — error handler provided to the subscriber
      //
      // Pattern (1) firstValueFrom + try/catch is already handled by standard isInTryCatch().
      //
      // Implementation: walk the immediate parent chain from the detection node. The detection
      // node is the httpService.X(url) CallExpression. Its parent structure is:
      //
      //   For .pipe(): CallExpr → PropertyAccess(.pipe) → CallExpr(.pipe(args...))
      //   For .subscribe(): CallExpr → PropertyAccess(.subscribe) → CallExpr(.subscribe({...}))
      //
      // axiosRef postconditions (postconditionId.startsWith('axiosref-')) use the standard
      // Promise try-catch model and MUST NOT be suppressed here — they are not Observable.
      //
      // Evidence: concern-20260615-nestjs-axios-observable-handling-1 — 3 FPs in ground-truth
      // fixture (lines 25/31 pipe+catchError, line 40 subscribe+error). When this suppression
      // lands, move those cases from known-scanner-gaps.ts → ground-truth.ts as SHOULD_NOT_FIRE.
      if (
        detection.packageName === "@nestjs/axios" &&
        !primaryPostcondition.id.startsWith("axiosref-") &&
        ts.isCallExpression(detection.node)
      ) {
        // Walk immediate parent: CallExpr → PropertyAccess → outer CallExpr
        const maybePropertyAccess = detection.node.parent;
        if (
          maybePropertyAccess &&
          ts.isPropertyAccessExpression(maybePropertyAccess) &&
          maybePropertyAccess.expression === detection.node
        ) {
          const chainName = maybePropertyAccess.name.text;
          const outerCall = maybePropertyAccess.parent;
          if (outerCall && ts.isCallExpression(outerCall)) {

            // Pattern (2): .pipe(catchError(handler))
            // The detection node is the receiver of .pipe(). One of .pipe()'s arguments
            // must be a catchError(handler) call (callee named 'catchError').
            if (chainName === "pipe") {
              const hasCatchError = outerCall.arguments.some((arg) => {
                if (!ts.isCallExpression(arg)) return false;
                // catchError(handler) — callee is Identifier('catchError')
                if (ts.isIdentifier(arg.expression) && arg.expression.text === "catchError") {
                  return true;
                }
                // Namespaced: operators.catchError(handler)
                if (
                  ts.isPropertyAccessExpression(arg.expression) &&
                  arg.expression.name.text === "catchError"
                ) {
                  return true;
                }
                return false;
              });
              if (hasCatchError) {
                // WAVE-2F: nestjs/axios Observable handled via .pipe(catchError(...)).
                trace.record(
                  MATCHER_IDS.SUPPRESSION_OBSERVABLE_HANDLED,
                  "passed",
                  ".pipe(catchError(...)) on Observable handles error channel",
                );
                continue;
              }
            }

            // Pattern (3): .subscribe({ next, error: handler })
            // The detection node is the receiver of .subscribe(). The argument object must
            // contain an 'error' property with a non-null (function-like) value.
            if (chainName === "subscribe") {
              const hasErrorHandler = outerCall.arguments.some((arg) => {
                if (!ts.isObjectLiteralExpression(arg)) return false;
                return arg.properties.some((prop) => {
                  // error: (e) => ... or error(e) { ... } (method shorthand)
                  if (ts.isPropertyAssignment(prop) && ts.isIdentifier(prop.name) && prop.name.text === "error") {
                    // Value must not be undefined/null literal — any non-trivial expression qualifies
                    return prop.initializer.kind !== ts.SyntaxKind.NullKeyword &&
                           prop.initializer.kind !== ts.SyntaxKind.UndefinedKeyword;
                  }
                  if (ts.isMethodDeclaration(prop) && ts.isIdentifier(prop.name) && prop.name.text === "error") {
                    return true;
                  }
                  return false;
                });
              });
              if (hasErrorHandler) {
                // WAVE-2F: nestjs/axios Observable handled via .subscribe({ error }).
                trace.record(
                  MATCHER_IDS.SUPPRESSION_OBSERVABLE_HANDLED,
                  "passed",
                  ".subscribe({ error }) on Observable handles error channel",
                );
                continue;
              }
            }
          }
        }
      }

      // Special-case: Clerk middleware postconditions require file-system inspection,
      // not try-catch analysis. auth() and clerkMiddleware() are never wrapped in try-catch
      // in a properly configured app — the check is whether middleware.ts is set up.
      const isClerkMiddlewarePostcondition =
        detection.packageName === "@clerk/nextjs" &&
        (primaryPostcondition.id === "missing-clerk-middleware" ||
          primaryPostcondition.id === "middleware-not-exported");

      if (isClerkMiddlewarePostcondition) {
        if (this.isClerkMiddlewareConfigured()) {
          // WAVE-2E: clerk middleware.ts configured — record CLERK_MIDDLEWARE_CONFIGURED
          // as passed and capture the site for the Wave 9 convention miner.
          trace.record(
            MATCHER_IDS.FRAMEWORK_CLERK_MIDDLEWARE_CONFIGURED,
            "passed",
          );
          this.recordPassedSite(
            detection,
            sourceFile,
            primaryPostcondition.id,
            MATCHER_IDS.FRAMEWORK_CLERK_MIDDLEWARE_CONFIGURED,
          );
          continue; // Middleware is properly configured — suppress violation
        }
        // Middleware not found: fall through to fire violation below (skip try-catch check)
      } else {
        const requiresNullCheck =
          primaryPostcondition.id.includes("null") &&
          (detection.pattern === "throwing-function" ||
            detection.pattern === "property-chain");

        if (requiresNullCheck) {
          // For null-check postconditions: skip if result is null-guarded
          if (this.controlFlow.isResultNullGuarded(detection.node)) {
            // WAVE-2F: null-check postcondition with explicit result null guard.
            trace.record(
              MATCHER_IDS.SUPPRESSION_NULL_GUARDED,
              "passed",
              "result is null-guarded — null-check postcondition satisfied",
            );
            continue;
          }
          // Not null-guarded: fall through to fire violation below.
          // WAVE-2F: record SUPPRESSION_NULL_GUARDED as failed so the violation
          // trace surfaces the missing null guard.
          trace.record(
            MATCHER_IDS.SUPPRESSION_NULL_GUARDED,
            "failed",
            "result is not null-guarded — null-check postcondition fires",
          );
        } else {
          // Standard try-catch analysis: accept either try-catch or .catch() chain
          // Also accept Supabase's idiomatic { error } destructuring + if check pattern.
          //
          // WAVE-2A: CANONICAL PATTERN.
          // OR-chain broken into 4 sequential trace.record() calls so the
          // detectionTrace captures EVERY matcher's outcome, not just the
          // first short-circuit (Pitfall 1 mitigation). Plans 01-04..01-08
          // mirror this pattern for their package families.
          //
          // WAVE-2E (Plan 01-07) — Pitfall 7 fix. For @sentry/* span-lifecycle
          // postconditions, NONE of the four OR-chain matchers semantically
          // satisfy the postcondition: a try/catch wrapper, .catch() handler,
          // onError option, or destructured error tuple all permit the inner
          // span to leak (the required pattern is `try { ... } finally {
          // span.end(); }`). Recording these matchers as `passed` would lie to
          // the trace — Pitfall 7 in RESEARCH. We DELIBERATELY skip the four
          // record() calls when the postcondition is sentry-lifecycle so
          // DetectionTraceAccumulator.serialize() Pass 2 emits all four as
          // `not_applicable` (per the Plan 01-04 inverted Pass 2 semantics).
          // The applicabilityPredicate in registry.ts ALSO gates these four
          // matchers off for sentry-lifecycle as belt-and-suspenders (so a
          // future code path that forgets to skip still produces the right
          // not_applicable surface).
          const isSentryLifecycleForTrace =
            detection.packageName.startsWith("@sentry/") &&
            (primaryPostcondition.id === "span-manual-finish-never-called" ||
              primaryPostcondition.id === "inactive-span-end-never-called");

          let inTryCatch = false;
          let firstPassedMatcher: string | null = null;

          if (
            detection.pattern === "throwing-function" ||
            detection.pattern === "property-chain" ||
            detection.pattern === "throwing-constructor"
          ) {
            // Matcher 1: enclosing try-catch (the standard direct pattern).
            const inTry = this.controlFlow.isInTryCatch(detection.node);
            if (!isSentryLifecycleForTrace) {
              trace.record(
                MATCHER_IDS.TRY_CATCH_DIRECT,
                inTry ? "passed" : "failed",
                inTry ? undefined : "no enclosing try",
              );
            }
            if (inTry && firstPassedMatcher === null) {
              firstPassedMatcher = MATCHER_IDS.TRY_CATCH_DIRECT;
            }

            // Matcher 2: .catch() handler on a Promise chain.
            const catchHandler =
              ts.isCallExpression(detection.node) &&
              this.controlFlow.hasCatchHandler(detection.node);
            if (!isSentryLifecycleForTrace) {
              trace.record(
                MATCHER_IDS.PROMISE_CATCH_HANDLER,
                catchHandler ? "passed" : "failed",
                catchHandler ? undefined : "no .catch() handler",
              );
            }
            if (catchHandler && firstPassedMatcher === null) {
              firstPassedMatcher = MATCHER_IDS.PROMISE_CATCH_HANDLER;
            }

            // Matcher 3: `onError` callback passed in an options bag.
            const onError =
              ts.isCallExpression(detection.node) &&
              this.controlFlow.hasOnErrorInOptions(detection.node);
            if (!isSentryLifecycleForTrace) {
              trace.record(
                MATCHER_IDS.OPTIONS_ON_ERROR,
                onError ? "passed" : "failed",
                onError ? undefined : "no onError option",
              );
            }
            if (onError && firstPassedMatcher === null) {
              firstPassedMatcher = MATCHER_IDS.OPTIONS_ON_ERROR;
            }

            // Matcher 4: Go-style destructured `[err, value] = await ...` tuple.
            const destructured =
              this.controlFlow.isDestructuredErrorTupleProtected(
                detection.node,
                sourceFile,
              );
            if (!isSentryLifecycleForTrace) {
              trace.record(
                MATCHER_IDS.DESTRUCTURED_ERROR_TUPLE,
                destructured ? "passed" : "failed",
                destructured ? undefined : "no destructured-error tuple",
              );
            }
            if (destructured && firstPassedMatcher === null) {
              firstPassedMatcher = MATCHER_IDS.DESTRUCTURED_ERROR_TUPLE;
            }

            // Matcher 5: fp-ts / functional tryCatch wrapper.
            //
            // TE.tryCatch(async () => risky(), onError) is the fp-ts idiom for
            // "run the async callback and capture any rejection in the Left".
            // The call site has no try-catch but IS protected — the wrapper owns
            // the error. Narrowly scoped to the `tryCatch` method name only.
            //
            // Evidence: concern-20260712-lead-13-fp-ts-tryCatch-wrapping
            // (hoppscotch — axios.post inside TE.tryCatch throughout frontend).
            const insideFpTsTryCatch = this.isInsideFunctionalTryCatch(
              detection.node,
              sourceFile,
            );
            if (!isSentryLifecycleForTrace) {
              trace.record(
                MATCHER_IDS.SUPPRESSION_CALLBACK_WRAPPER_SHELL,
                insideFpTsTryCatch ? "passed" : "failed",
                insideFpTsTryCatch
                  ? undefined
                  : "not inside a functional tryCatch wrapper",
              );
            }
            if (insideFpTsTryCatch && firstPassedMatcher === null) {
              firstPassedMatcher = MATCHER_IDS.SUPPRESSION_CALLBACK_WRAPPER_SHELL;
            }

            inTryCatch =
              inTry || catchHandler || onError || destructured || insideFpTsTryCatch;

            // WAVE-2D: AWS SDK matchers. For @aws-sdk/* packages, also record
            // the per-command-family matcher so the trace surfaces a
            // passed/failed AWS_* entry (not the default not_applicable from
            // the registry walk). The command-class suffix (e.g.
            // aws:s3-command:GetObjectCommand) is also recorded with the same
            // status so the Wave 9 convention miner can group AND drill down.
            const awsMatcherIdEarly = ContractMatcher.awsCommandMatcherIdFor(
              detection.packageName,
            );
            if (awsMatcherIdEarly !== null) {
              const status = inTryCatch ? "passed" : "failed";
              const reason = inTryCatch ? undefined : "aws command call outside try-catch";
              trace.record(awsMatcherIdEarly, status, reason);
              const cmdClassEarly = this.extractAwsCommandClass(detection);
              if (cmdClassEarly !== null) {
                trace.record(
                  `${awsMatcherIdEarly}:${cmdClassEarly}`,
                  status,
                  reason,
                );
              }
            }
          }

          if (inTryCatch) {
            // @sentry/* startSpanManual and startInactiveSpan: outer try-catch does NOT
            // satisfy the postcondition. These require a finally block INSIDE the callback
            // (startSpanManual) or around the span usage (startInactiveSpan). The checks
            // above already verified the required pattern is absent — fall through to fire.
            // Evidence: concern-20260611-sentry-node-deepen-1 and -2
            const isSentryLifecyclePostcondition =
              detection.packageName.startsWith("@sentry/") &&
              (primaryPostcondition.id === "span-manual-finish-never-called" ||
                primaryPostcondition.id === "inactive-span-end-never-called");
            if (!isSentryLifecyclePostcondition) {
              // Inside try-catch: fire warnings for incomplete error handling patterns
              const catchClause = this.controlFlow.getEnclosingCatchClause(
                detection.node,
              );
              if (catchClause) {
                const catchViolation = this.checkCatchBlockCompleteness(
                  detection,
                  postconditions,
                  catchClause,
                  sourceFile,
                );
                if (catchViolation) {
                  // WAVE-2A: warning-level catch violations also carry trace.
                  catchViolation.detectionTrace = trace.serialize();
                  violations.push(catchViolation);
                }
              }
              // WAVE-2A: passing-site recorded for Wave 9 convention-miner.
              // Restricted to HTTP-client packages in this wave; Plans 01-04..01-08
              // extend to additional families as their matchers get wired.
              if (
                firstPassedMatcher !== null &&
                ContractMatcher.HTTP_CLIENTS.has(detection.packageName)
              ) {
                const { line: passedLine } = this.getLocation(
                  detection.node,
                  sourceFile,
                );
                this._lastPassedDetections.push({
                  packageName: detection.packageName,
                  postconditionId: primaryPostcondition.id,
                  file: sourceFile.fileName,
                  line: passedLine,
                  passedMatcherId: firstPassedMatcher,
                });
              }
              // WAVE-2D: AWS SDK per-command-family passing-site recording.
              // The AWS_* matcher itself was already recorded (passed/failed)
              // immediately after the canonical OR-chain at ~line 2470, so
              // the trace surface is complete. Here we additionally buffer
              // the passing site into _lastPassedDetections (gated by
              // PASSING_SITE_PACKAGES membership inside recordPassedSite) so
              // the Wave 9 convention miner can spot "this repo wraps all S3
              // calls" patterns across files. The AWS family matcher ID
              // (not the command-class-suffixed variant) is used here so the
              // miner aggregates at the family level; the per-command
              // breakdown lives in the trace.
              if (firstPassedMatcher !== null) {
                const awsMatcherIdPass =
                  ContractMatcher.awsCommandMatcherIdFor(
                    detection.packageName,
                  );
                if (awsMatcherIdPass !== null) {
                  this.recordPassedSite(
                    detection,
                    sourceFile,
                    primaryPostcondition.id,
                    awsMatcherIdPass,
                  );
                }
              }
              continue;
            }
            // isSentryLifecyclePostcondition: fall through to fire even though inTryCatch
          }
        }
      }

      // Outside try-catch (or null-check postcondition without null guard):
      // For @aws-sdk/client-s3 send(): resolve postcondition based on the command
      // argument type (e.g. ListObjectsV2Command → warning, GetObjectCommand → error).
      // For all other packages: pick the most severe postcondition.
      //
      // WAVE-2D: the AWS_S3_COMMAND matcher record (and its `:<CommandClass>`
      // suffixed variant) was emitted at the canonical OR-chain (line ~2470)
      // BEFORE the postcondition gets refined here; the per-command resolution
      // below is what makes the violation message + severity match the
      // specific command (GetObjectCommand=error vs ListObjectsV2Command=warning)
      // while the trace already carries the AWS_* matcher status and command
      // class for the Wave 9 convention miner.
      let postconditionResolved = false;
      let postcondition = this.pickMostSevere(postconditions);
      if (
        detection.packageName === "@aws-sdk/client-s3" &&
        detection.functionName === "send"
      ) {
        const commandSpecific = this.pickS3SendPostcondition(
          detection,
          postconditions,
        );
        if (commandSpecific) {
          postcondition = commandSpecific;
          postconditionResolved = true;
        }
      }

      // @aws-sdk/client-ses send(): resolve postcondition based on the command
      // argument type. Each SES command has distinct error types; command-specific
      // postconditions provide more actionable guidance than the generic ses-send-no-try-catch.
      //
      // WAVE-2D: SES — see WAVE-2D rationale at S3 resolver above. AWS_SES_COMMAND
      // already recorded; this branch resolves the violation message.
      //
      // Evidence: concern-20260415-@aws-sdk-client-ses-deepen-1 through -6 (6 uncovered
      // SES command functions: SendEmailCommand, TestRenderTemplateCommand,
      // CreateConfigurationSetCommand, CreateConfigurationSetEventDestinationCommand,
      // CreateCustomVerificationEmailTemplateCommand, UpdateCustomVerificationEmailTemplateCommand).
      if (
        !postconditionResolved &&
        detection.packageName === "@aws-sdk/client-ses" &&
        detection.functionName === "send"
      ) {
        const commandSpecific = this.pickSesSendPostcondition(
          detection,
          postconditions,
          contract,
        );
        if (commandSpecific) {
          postcondition = commandSpecific;
          postconditionResolved = true;
        }
      }

      // @aws-sdk/client-sesv2 send(): resolve postcondition based on the command
      // argument type. Each SESv2 command has distinct error types; command-specific
      // postconditions provide more actionable guidance than the generic sesv2-send-no-try-catch.
      //
      // WAVE-2D: SESv2 — AWS_SESV2_COMMAND already recorded at canonical OR-chain;
      // this branch refines the violation message + severity per command class.
      //
      // Evidence: concern-20260416-sesv2-deepen-1 (SendEmailCommand),
      //           concern-20260416-sesv2-deepen-3 (CreateEmailIdentityCommand),
      //           concern-20260416-sesv2-deepen-4 (CreateImportJobCommand).
      if (
        !postconditionResolved &&
        detection.packageName === "@aws-sdk/client-sesv2" &&
        detection.functionName === "send"
      ) {
        const commandSpecific = this.pickSesv2SendPostcondition(
          detection,
          postconditions,
          contract,
        );
        if (commandSpecific) {
          postcondition = commandSpecific;
          postconditionResolved = true;
        }
      }

      // @aws-sdk/client-sqs send(): resolve postcondition based on the command
      // argument type. CreateQueueCommand, PurgeQueueCommand, ChangeMessageVisibilityCommand
      // each have unique error types; command-specific postconditions are more actionable
      // than the generic aws-service-error.
      //
      // WAVE-2D: SQS — AWS_SQS_COMMAND already recorded at canonical OR-chain
      // with the command class suffix (e.g. aws:sqs-command:CreateQueueCommand).
      //
      // Evidence: concern-20260416-aws-sqs-deepen-4 (ChangeMessageVisibilityCommand —
      // sqs-change-visibility-not-inflight). Also covers CreateQueueCommand and PurgeQueueCommand
      // which were in the ground-truth fixture but lacked pending concerns.
      if (
        !postconditionResolved &&
        detection.packageName === "@aws-sdk/client-sqs" &&
        detection.functionName === "send"
      ) {
        const commandSpecific = this.pickSqsSendPostcondition(
          detection,
          postconditions,
          contract,
        );
        if (commandSpecific) {
          postcondition = commandSpecific;
          postconditionResolved = true;
        }
      }

      // @aws-sdk/client-secrets-manager send(): resolve postcondition based on the command
      // argument type. UpdateSecretVersionStageCommand, CancelRotateSecretCommand,
      // PutResourcePolicyCommand, and RestoreSecretCommand each have unique error types;
      // command-specific postconditions are more actionable than the generic aws-service-error.
      //
      // WAVE-2D: Secrets Manager — AWS_SECRETS_MANAGER_COMMAND already recorded at
      // canonical OR-chain with the command class suffix. Convention miner can group
      // by `aws:secrets-manager-command:*` to spot repos that wrap all secret reads.
      //
      // Evidence: concern-20260611-aws-sdk-client-secrets-manager-deepen-5 (UpdateSecretVersionStageCommand),
      //           concern-20260611-aws-sdk-client-secrets-manager-deepen-6 (CancelRotateSecretCommand),
      //           concern-20260611-aws-sdk-client-secrets-manager-deepen-7 (PutResourcePolicyCommand),
      //           concern-20260611-aws-sdk-client-secrets-manager-deepen-8 (RestoreSecretCommand).
      if (
        !postconditionResolved &&
        detection.packageName === "@aws-sdk/client-secrets-manager" &&
        detection.functionName === "send"
      ) {
        const commandSpecific = this.pickSecretsManagerSendPostcondition(
          detection,
          postconditions,
          contract,
        );
        if (commandSpecific) {
          postcondition = commandSpecific;
          postconditionResolved = true;
        }
      }

      // superagent chained-method postcondition selector.
      // superagent.get(url).timeout({...}) and superagent.get(url).maxResponseSize(n)
      // are method-chained calls. The entire expression `superagent.get(url).timeout({...})`
      // is an await target, but the detection fires on the `.get()` call node.
      // The parent of the `.get()` CallExpression is a PropertyAccessExpression (`.timeout`
      // or `.maxResponseSize`), then another CallExpression — this is how chaining works.
      //
      // We walk up the AST from the detection node to find any method names in the chain
      // that indicate a specific postcondition should be selected over the default.
      //
      // Evidence: superagent deepen concerns 1 (timeout-error-identifiable) and 2 (max-response-size-exceeded)
      if (!postconditionResolved && detection.packageName === "superagent") {
        const chainedSpecific = this.pickSuperagentChainedPostcondition(
          detection,
          postconditions,
        );
        if (chainedSpecific) {
          postcondition = chainedSpecific;
          postconditionResolved = true;
        }
      }

      // jsonschema validate(): resolve postcondition based on the options argument.
      // validate() only throws when throwFirst, throwAll, or throwError is set.
      // Without throw options, it returns a ValidatorResult (no exception possible).
      // We inspect the 3rd argument to determine which throw-option postcondition to fire,
      // or suppress entirely if no throw option is present.
      //
      // Evidence: concern-20260416-jsonschema-deepen-4 and -5 (validate-result-unchecked,
      // validator-validate-unresolved-ref); option routing for throwFirst/throwAll/throwError.
      if (
        !postconditionResolved &&
        detection.packageName === "jsonschema" &&
        detection.functionName === "validate"
      ) {
        const optionSpecific = this.pickJsonschemaValidatePostcondition(
          detection,
          postconditions,
        );
        if (optionSpecific === null) {
          // No throw option present — validate() will not throw, skip violation
          // WAVE-2F: jsonschema validate() without throwFirst/throwAll/throwError
          // options returns a result object instead of throwing.
          trace.record(
            MATCHER_IDS.SUPPRESSION_OPTION_SUPPRESSES,
            "passed",
            "jsonschema validate() without throw* options — returns result, never throws",
          );
          continue;
        }
        if (optionSpecific) {
          postcondition = optionSpecific;
          postconditionResolved = true;
        }
      }

      // ofetch / $fetch / ofetch.raw: option-aware postcondition routing.
      //
      // 1. ignoreResponseError suppression: ofetch.raw() with { ignoreResponseError: true }
      //    behaves like native fetch() — returns the response for all status codes without
      //    throwing FetchError. This is a documented ofetch escape hatch for inspecting error
      //    responses. Suppress raw-still-throws-on-error when this option is statically present.
      //    Evidence: concern-20260418-ofetch-deepen-1 (ground-truth rawWithIgnoreError).
      //
      // 2. timeout option routing: when ofetch() / $fetch() is called with { timeout: N },
      //    fire ofetch-timeout-unhandled (more specific guidance about TimeoutError) rather
      //    than the generic ofetch-no-try-catch. Both indicate a missing try-catch, but the
      //    timeout variant tells the developer to check error.cause?.name === 'TimeoutError'.
      //    Evidence: concern-20260418-ofetch-deepen-2 (ground-truth fetchWithTimeoutNoCatch).
      if (
        detection.packageName === "ofetch" &&
        ts.isCallExpression(detection.node)
      ) {
        // Detect the options argument: ofetch(url, opts) → args[1]; ofetch.raw(url, opts) → args[1]
        const ofetchArgs = detection.node.arguments;
        const ofetchOptsArg = ofetchArgs.length >= 2 ? ofetchArgs[1] : undefined;

        if (ofetchOptsArg && ts.isObjectLiteralExpression(ofetchOptsArg)) {
          const ofetchOptionKeys = new Map<string, ts.Expression>();
          for (const prop of ofetchOptsArg.properties) {
            if (ts.isPropertyAssignment(prop) && ts.isIdentifier(prop.name)) {
              ofetchOptionKeys.set(prop.name.text, prop.initializer);
            }
          }

          // 1. ignoreResponseError suppression (raw-still-throws-on-error only)
          if (
            ofetchOptionKeys.has("ignoreResponseError") &&
            postcondition.id === "raw-still-throws-on-error"
          ) {
            const ignoreVal = ofetchOptionKeys.get("ignoreResponseError");
            // Only suppress when literally `true` — false/variable cannot be statically determined
            if (ignoreVal && ignoreVal.kind === ts.SyntaxKind.TrueKeyword) {
              // WAVE-2F: ofetch.raw({ ignoreResponseError: true }) — option
              // disables the throw, returns response for all status codes.
              trace.record(
                MATCHER_IDS.SUPPRESSION_OPTION_SUPPRESSES,
                "passed",
                "ofetch.raw({ ignoreResponseError: true }) — option disables throw",
              );
              continue;
            }
          }

          // 2. timeout option routing: prefer ofetch-timeout-unhandled over ofetch-no-try-catch
          if (
            ofetchOptionKeys.has("timeout") &&
            !postconditionResolved &&
            (postcondition.id === "ofetch-no-try-catch" ||
              postcondition.id === "dollar-fetch-no-try-catch")
          ) {
            const timeoutSpecific = postconditions.find(
              (p) =>
                p.id === "ofetch-timeout-unhandled" ||
                p.id === "raw-timeout-unhandled",
            );
            if (timeoutSpecific) {
              postcondition = timeoutSpecific;
              postconditionResolved = true;
            }
          }
        }
      }

      // cross-fetch: option-aware postcondition routing for { timeout } init option.
      //
      // When fetch() is called with { timeout: N } (a node-fetch-specific extension exposed
      // by cross-fetch on Node.js), prefer the more specific fetch-request-timeout-error
      // postcondition over the generic network-error one. Both indicate a missing try-catch,
      // but the timeout variant tells the developer to check error.name === 'FetchError'
      // && error.type === 'request-timeout', which is distinct from the AbortError path.
      //
      // Note: this only routes the request-timeout case. The body-timeout and max-size
      // variants would require tracking the response variable across calls (data-flow
      // analysis) — out of scope for option-aware routing at the fetch() call site.
      //
      // Evidence: concern-20260612-cross-fetch-deepen-1
      // Precedent: same shape as the ofetch timeout routing immediately above.
      if (
        detection.packageName === "cross-fetch" &&
        ts.isCallExpression(detection.node) &&
        !postconditionResolved &&
        postcondition.id === "network-error"
      ) {
        const crossFetchArgs = detection.node.arguments;
        const crossFetchOptsArg =
          crossFetchArgs.length >= 2 ? crossFetchArgs[1] : undefined;
        if (
          crossFetchOptsArg &&
          ts.isObjectLiteralExpression(crossFetchOptsArg)
        ) {
          let hasTimeoutOption = false;
          for (const prop of crossFetchOptsArg.properties) {
            if (
              ts.isPropertyAssignment(prop) &&
              ts.isIdentifier(prop.name) &&
              prop.name.text === "timeout"
            ) {
              hasTimeoutOption = true;
              break;
            }
          }
          if (hasTimeoutOption) {
            const timeoutSpecific = postconditions.find(
              (p) => p.id === "fetch-request-timeout-error",
            );
            if (timeoutSpecific) {
              postcondition = timeoutSpecific;
              postconditionResolved = true;
            }
          }
        }
      }

      // Skip warning-only postconditions that have no `throws` — these are informational
      // return-value risks (e.g., dayjs.format ReDoS) that don't require try-catch handling.
      // Warning postconditions WITH `throws` (e.g., clerk setActive) should still fire.
      if (postcondition.severity !== "error" && !postcondition.throws) {
        // WAVE-2F: postcondition is informational (warning + no throws) — no
        // error-handling guard applies.
        trace.record(
          MATCHER_IDS.SUPPRESSION_NEVER_THROWS,
          "passed",
          `warning-level postcondition "${postcondition.id}" has no throws — no try-catch required`,
        );
        continue;
      }

      // Clerk-specific: suppress use-clerk-outside-provider when ClerkProvider is found in the project.
      // Next.js App Router apps wrap the root layout in ClerkProvider, so useClerk() is always
      // inside a provider at runtime. Static analysis cannot trace the component hierarchy.
      if (
        detection.packageName === "@clerk/nextjs" &&
        postcondition.id === "use-clerk-outside-provider"
      ) {
        if (this.projectHasClerkProvider()) {
          // WAVE-2E: project has ClerkProvider in the component tree — record
          // CLERK_MIDDLEWARE_CONFIGURED as passed. The matcher's name reflects
          // the broader "clerk is properly configured at the project level"
          // family (middleware + provider both signal the same convention).
          trace.record(
            MATCHER_IDS.FRAMEWORK_CLERK_MIDDLEWARE_CONFIGURED,
            "passed",
          );
          this.recordPassedSite(
            detection,
            sourceFile,
            postcondition.id,
            MATCHER_IDS.FRAMEWORK_CLERK_MIDDLEWARE_CONFIGURED,
          );
          continue; // ClerkProvider present — suppress false positive
        }
      }

      // zod: parse-validation-error in Next.js API route handlers — suppress.
      // Next.js App Router route handlers (app/api/**/*.ts, app/api/**/*.tsx) are
      // automatically wrapped in Next.js's error boundary: unhandled exceptions return
      // a 500 response, they do NOT crash the process. Requiring try-catch inside every
      // route handler is overly prescriptive — Next.js handles this at the framework level.
      //
      // Also suppress in React component files that use zod for form validation alongside
      // react-hook-form or similar form libraries. In this pattern, zod schema.parse() is
      // called during form submission where the form library (RHF, Formik) or the component
      // already provides error handling through form state, not try-catch.
      //
      // Evidence: concern-2026-04-06-zod-7 — 14 FP instances in apps/web/app/api/**/*.ts
      // Evidence: concern-2026-04-20-zod-8 — 14 FP instances in auth forms and component files
      // (src/features/auth/**/*.tsx, src/features/customers/**/*.tsx) that use zod with RHF.
      if (
        detection.packageName === "zod" &&
        postcondition.id === "parse-validation-error"
      ) {
        const fileName = sourceFile.fileName;
        // Match Next.js App Router API route files
        if (
          /[/\\]app[/\\]api[/\\]/.test(fileName) &&
          /\.tsx?$/.test(fileName)
        ) {
          // WAVE-2F: Next.js app/api route handler — framework wraps in
          // error boundary, uncaught exceptions return 500.
          trace.record(
            MATCHER_IDS.SUPPRESSION_FRAMEWORK_BOUNDARY,
            "passed",
            "Next.js app/api route — framework error boundary handles throws",
          );
          continue;
        }
        // React component files (.tsx) using zod for form validation
        // The form library (RHF, etc.) handles validation errors through form state, not try-catch.
        if (/\.tsx$/.test(fileName)) {
          const zodFileText = sourceFile.getFullText();
          if (
            zodFileText.includes("handleSubmit") ||
            zodFileText.includes("useForm") ||
            zodFileText.includes("zodResolver") ||
            zodFileText.includes("formState") ||
            zodFileText.includes("safeParse")
          ) {
            // WAVE-2F: React component file with form-library wiring —
            // RHF / Formik / safeParse surfaces validation errors via form state.
            trace.record(
              MATCHER_IDS.SUPPRESSION_FRAMEWORK_BOUNDARY,
              "passed",
              "React component file with form-library — validation errors via form state",
            );
            continue;
          }
        }
      }

      // zod: suppress parse-validation-error / parse-type-coercion-error / parse-async-schema-error
      // when parse() is used as an intentional assertion (config/factory/startup validation).
      // In these contexts, invalid data means a programming bug — crashing loudly is correct.
      // Evidence: civitai audit 2026-05-05 — 8 FPs in orchestrator config inputFn callbacks.
      if (
        detection.packageName === "zod" &&
        (postcondition.id === "parse-validation-error" ||
          postcondition.id === "parse-type-coercion-error" ||
          postcondition.id === "parse-async-schema-error") &&
        this.isZodAssertionStyleParse(detection.node)
      ) {
        // WAVE-2F: zod parse() used as an intentional assertion
        // (config/factory/startup validation) — crashing loudly is correct.
        trace.record(
          MATCHER_IDS.SUPPRESSION_PROJECT_ARCHITECTURE,
          "passed",
          "zod parse() used as intentional assertion — crash-on-invalid is correct",
        );
        continue;
      }

      // @upstash/redis: network-or-api-error — suppress for module-level singleton exports.
      // Same pattern as ioredis: the Redis client is created at module level and exported;
      // error handlers (.on('error') or pipeline-level handling) are registered elsewhere.
      // Evidence: concern-2026-04-06-upstash-redis-22 — 1 FP: apps/web/utils/redis/index.ts:10
      // (top-level export const redis = new Redis(...)).
      if (
        detection.packageName === "@upstash/redis" &&
        postcondition.id === "network-or-api-error"
      ) {
        let isTopLevelSingleton = false;
        let cur: ts.Node | undefined = detection.node.parent;
        while (cur) {
          if (ts.isVariableDeclaration(cur)) {
            const varDeclList = cur.parent;
            if (varDeclList && ts.isVariableDeclarationList(varDeclList)) {
              const varStmt = varDeclList.parent;
              if (
                varStmt &&
                ts.isVariableStatement(varStmt) &&
                ts.isSourceFile(varStmt.parent)
              ) {
                isTopLevelSingleton = true;
              }
            }
            break;
          }
          if (
            ts.isFunctionDeclaration(cur) ||
            ts.isFunctionExpression(cur) ||
            ts.isArrowFunction(cur) ||
            ts.isMethodDeclaration(cur) ||
            ts.isClassDeclaration(cur)
          )
            break;
          cur = cur.parent;
        }
        if (isTopLevelSingleton) {
          // WAVE-2F: @upstash/redis module-level singleton — error listeners
          // are registered elsewhere (bootstrap/init code).
          trace.record(
            MATCHER_IDS.SUPPRESSION_FILE_SCOPE,
            "passed",
            "@upstash/redis top-level singleton — listeners registered elsewhere",
          );
          continue;
        }
      }

      // redis (node-redis): missing-error-listener — suppress for module-level singleton exports,
      // when the file registers .on('error') anywhere, or when the creation is in a bootstrap/
      // initialization module where error listeners are registered after the function returns
      // (cross-function or cross-file registration pattern).
      // The redis client is typically created at module level and exported as a singleton.
      // Error listeners (.on('error')) are registered in the application bootstrap,
      // not inline with the client definition. The scanner cannot trace cross-file event listener
      // registration.
      // Evidence: concern-2026-04-06-redis-1 — 7 FP instances in packages/api/src/main.ts
      // (module-level redis client creation, error handler registered elsewhere in the same file
      // or in bootstrap code).
      // Evidence: concern-20260429-redis-1 — 7 FP instances where .on('error') is registered in
      // an initialization function that is separate from the createClient() call site.
      if (
        detection.packageName === "redis" &&
        postcondition.id === "missing-error-listener"
      ) {
        // Suppress when the file already registers .on('error') anywhere
        const redisFileText = sourceFile.getFullText();
        if (
          redisFileText.includes(".on('error'") ||
          redisFileText.includes('.on("error"') ||
          redisFileText.includes(".on(`error`")
        ) {
          // WAVE-2F: file registers .on('error') for the redis client.
          trace.record(
            MATCHER_IDS.SUPPRESSION_PROJECT_ARCHITECTURE,
            "passed",
            "file registers .on('error') listener for redis client",
          );
          continue;
        }
        // Suppress in bootstrap/initialization files (main.ts, server.ts, app.ts, index.ts)
        // These files assemble the application; redis clients created here have their error
        // listeners registered externally (callers invoke init functions that attach listeners).
        const redisFileName = sourceFile.fileName;
        if (
          /[/\\](main|server|app|index)\.(ts|tsx)$/.test(redisFileName) ||
          /[/\\](bootstrap|startup|init)\.(ts|tsx)$/.test(redisFileName)
        ) {
          // WAVE-2F: bootstrap/initialization file — caller wires the
          // .on('error') listener after createClient() returns.
          trace.record(
            MATCHER_IDS.SUPPRESSION_FILE_SCOPE,
            "passed",
            "redis client in bootstrap/initialization file — listeners registered by caller",
          );
          continue;
        }
        // Also suppress for module-level singleton exports (same ioredis pattern)
        let isRedisTopLevel = false;
        let redisCur: ts.Node | undefined = detection.node.parent;
        while (redisCur) {
          if (ts.isVariableDeclaration(redisCur)) {
            const varDeclList = redisCur.parent;
            if (varDeclList && ts.isVariableDeclarationList(varDeclList)) {
              const varStmt = varDeclList.parent;
              if (
                varStmt &&
                ts.isVariableStatement(varStmt) &&
                ts.isSourceFile(varStmt.parent)
              ) {
                isRedisTopLevel = true;
              }
            }
            break;
          }
          if (
            ts.isFunctionDeclaration(redisCur) ||
            ts.isFunctionExpression(redisCur) ||
            ts.isArrowFunction(redisCur) ||
            ts.isMethodDeclaration(redisCur) ||
            ts.isClassDeclaration(redisCur)
          )
            break;
          redisCur = redisCur.parent;
        }
        if (isRedisTopLevel) {
          // WAVE-2F: redis client is a module-level singleton — error listener
          // registered elsewhere in the file or in caller bootstrap code.
          trace.record(
            MATCHER_IDS.SUPPRESSION_FILE_SCOPE,
            "passed",
            "redis client at module top-level — listeners registered elsewhere",
          );
          continue;
        }
      }

      // winston: missing-error-listener — suppress in script files.
      // Winston loggers created in one-off scripts (scripts/, setup files, migration files)
      // that run to completion and exit; uncaught transport errors won't crash a long-running
      // service. Also suppress when the file registers .on('error') anywhere.
      // Evidence: concern-2026-04-06-winston-24 — 1 FP: apps/web/scripts/setup-telegram-bot.ts
      if (
        detection.packageName === "winston" &&
        postcondition.id === "missing-error-listener"
      ) {
        const fileName = sourceFile.fileName;
        const fileText = sourceFile.getFullText();
        // Suppress for script/setup files
        if (
          /[/\\](scripts|setup|migrations?|seed)[/\\]/i.test(fileName) ||
          fileName.toLowerCase().includes("setup-")
        ) {
          // WAVE-2F: winston in a one-off script/setup file — not a long-
          // running service, transport errors don't matter.
          trace.record(
            MATCHER_IDS.SUPPRESSION_FILE_SCOPE,
            "passed",
            "winston logger in script/setup file — not a long-running service",
          );
          continue;
        }
        // Suppress when file already has error listener
        if (
          fileText.includes(".on('error'") ||
          fileText.includes('.on("error"')
        ) {
          // WAVE-2F: file registers .on('error') for the winston logger.
          trace.record(
            MATCHER_IDS.SUPPRESSION_PROJECT_ARCHITECTURE,
            "passed",
            "file registers .on('error') listener for winston logger",
          );
          continue;
        }
      }

      // node-fetch: fetch-rejects-on-network-error — suppress in AI utility/client wrapper files.
      // When node-fetch is used inside a utility function (ai-client.ts, analysis utils) that
      // is itself called by consumers who are expected to handle errors, the error propagates
      // to the caller. These wrapper patterns are equivalent to the Supabase return-delegate
      // suppression — errors are delegated, not swallowed.
      // Evidence: concern-2026-04-06-node-fetch-1 — 2 FPs:
      //   api/utils/ai-client.ts:20, api/analysis/post-game-analysis.ts:67
      if (
        detection.packageName === "node-fetch" &&
        postcondition.id === "fetch-rejects-on-network-error"
      ) {
        // Suppress when the fetch call is inside a function that itself returns/propagates
        // the result (not in an event handler or fire-and-forget context).
        // Pattern: utility files (utils/, analysis/) that make fetch calls on behalf of callers.
        const fileName = sourceFile.fileName;
        if (
          /[/\\](utils?|helpers?|analysis|client)[/\\]/i.test(fileName) ||
          fileName.toLowerCase().includes("-client.ts") ||
          fileName.toLowerCase().includes("-util.ts")
        ) {
          // Verify it's inside a regular async function (not event handler)
          let cur: ts.Node | undefined = detection.node;
          let enclosingFunc:
            | ts.FunctionDeclaration
            | ts.ArrowFunction
            | ts.FunctionExpression
            | ts.MethodDeclaration
            | null = null;
          while (cur) {
            if (
              ts.isFunctionDeclaration(cur) ||
              ts.isArrowFunction(cur) ||
              ts.isFunctionExpression(cur) ||
              ts.isMethodDeclaration(cur)
            ) {
              enclosingFunc = cur as
                | ts.FunctionDeclaration
                | ts.ArrowFunction
                | ts.FunctionExpression
                | ts.MethodDeclaration;
              break;
            }
            cur = cur.parent;
          }
          if (enclosingFunc) {
            // WAVE-2F: node-fetch in a utility/wrapper file (utils/, helpers/,
            // analysis/, client/) — caller is responsible for error handling.
            trace.record(
              MATCHER_IDS.SUPPRESSION_RETURN_DELEGATE,
              "passed",
              "node-fetch in utility/wrapper file — caller handles errors",
            );
            continue;
          }
        }
      }

      // @supabase/supabase-js: weak-password postcondition — suppress in auth context files.
      // The weak-password postcondition fires when signUp/updateUser is called without
      // validating password strength beforehand. In auth-context.tsx and similar auth wrapper
      // files, the password validation is done at the UI layer (form validation) before the
      // Supabase call is made. This is the standard pattern in React auth contexts.
      // Evidence: concern-2026-04-06-supabase-supabase-js-25 — 1 FP: src/contexts/auth-context.tsx:85
      if (
        detection.packageName === "@supabase/supabase-js" &&
        postcondition.id === "weak-password"
      ) {
        const fileName = sourceFile.fileName;
        // Suppress in React auth context/provider files — password validation is at the form layer
        if (
          /[/\\](contexts?|providers?)[/\\]/i.test(fileName) ||
          fileName.toLowerCase().includes("auth-context") ||
          fileName.toLowerCase().includes("auth-provider")
        ) {
          // WAVE-2F: supabase auth call in a React auth context/provider —
          // password strength validation is performed at the form/UI layer.
          trace.record(
            MATCHER_IDS.SUPPRESSION_FILE_SCOPE,
            "passed",
            "supabase auth in React auth-context file — password validated at form layer",
          );
          continue;
        }
        // Also suppress when the file contains password validation patterns
        const fileText = sourceFile.getFullText();
        if (
          fileText.includes("minLength") ||
          fileText.includes("passwordStrength") ||
          fileText.includes("validatePassword") ||
          fileText.includes("password.length")
        ) {
          // WAVE-2F: file contains password validation patterns (minLength,
          // passwordStrength, validatePassword) before the Supabase call.
          trace.record(
            MATCHER_IDS.SUPPRESSION_PROJECT_ARCHITECTURE,
            "passed",
            "file validates password strength before Supabase call",
          );
          continue;
        }
      }

      // dotenv: missing-env-file — extend suppression to cover script/migration files
      // where dotenv.config() is called at top-level but process.env usage is not
      // immediately adjacent (the whole-file lookahead should cover this, but add
      // unconditional suppression for files in scripts/ and migrations/ directories).
      // Evidence: concern-2026-04-06-dotenv-15 — 3 FPs: src/lib/migrations/supabase.ts:5
      // (the existing isMigrationScript suppression should have caught this — if still
      // firing, the file doesn't reference process.env at all; suppress unconditionally
      // for migration files since they're one-off setup scripts).
      if (
        detection.packageName === "dotenv" &&
        postcondition.id === "missing-env-file"
      ) {
        const fileName = sourceFile.fileName;
        if (/[/\\](migrations?|scripts?|setup|seed)[/\\]/i.test(fileName)) {
          // WAVE-2F: dotenv.config() in a one-off script/migration file —
          // env file errors are acceptable.
          trace.record(
            MATCHER_IDS.SUPPRESSION_FILE_SCOPE,
            "passed",
            "dotenv.config() in migration/script file — env file errors acceptable",
          );
          continue;
        }
      }

      // undici Dispatcher.close(): suppress dispatcher-close-already-destroyed when the
      // .close() call is on a WebSocket (or similar non-Dispatcher object), not on an
      // undici Client/Pool/Agent. The undici contract has class_names: [WebSocket, EventSource]
      // which causes classToPackage to map "WebSocket" → "undici". When a repo imports undici
      // (e.g. for fetch) AND uses a WebSocket instance, the instance tracker maps the ws
      // variable to undici. Any ws.close() or this.ws.close() call then fires the Dispatcher
      // postcondition — a false positive.
      //
      // Two discriminating signals:
      //   1. The close() call has arguments (numeric close code + optional reason string):
      //      this is the WebSocket close protocol (RFC 6455 §7.1.2). undici Dispatcher.close()
      //      takes no arguments in normal usage (it returns Promise<void>).
      //   2. The chain member name before .close is in the set of conventional WebSocket
      //      variable names: ws, socket, websocket, conn (common in the witsy/hoppscotch
      //      repos that triggered this concern). Checked case-insensitively.
      //
      // Evidence: concern-20260712-lead-05-undici-close-vs-websocket-close (lead #5 in
      // accuracy-roadmap README). witsy-labels-A/B both agreed FP for:
      //   this.ws.close(1000, 'Stream ended')    (line 461 — arg check catches this)
      //   this.streamingSession.close()           (line 154 — was a WebSocket per labels)
      // hoppscotch: 2 violations matching same pattern.
      //
      // The fix does NOT suppress ws.close() on objects that are NOT tracked to undici's
      // WebSocket class (the importMap path routes those detections correctly).
      // Reference: .claude/rules/cloud-scan-architecture.md does not apply here.
      if (
        detection.packageName === "undici" &&
        detection.functionName === "close" &&
        postcondition.id === "dispatcher-close-already-destroyed" &&
        ts.isCallExpression(detection.node)
      ) {
        const callArgs = detection.node.arguments;

        // Signal 1: close() called with arguments → WebSocket.close(code, reason)
        // undici Dispatcher.close() accepts no positional arguments.
        if (callArgs.length > 0) {
          trace.record(
            MATCHER_IDS.SUPPRESSION_PACKAGE_NOT_IMPORTED,
            "passed",
            "undici close() with arguments — WebSocket.close(code, reason), not Dispatcher.close()",
          );
          continue;
        }

        // Signal 2: the chain member name (the variable before .close) matches common
        // WebSocket variable naming conventions. The chainStr from PropertyChainDetector
        // is "ws.close", "socket.close", etc. For ThrowingFunctionDetector the metadata
        // chain is ["ws", "close"]. Either way, the first segment before .close is the var.
        const chain = detection.metadata?.chain as string[] | undefined;
        const chainStr = detection.metadata?.chainStr as string | undefined;
        // Extract the member name that .close() is called on
        const memberName = chainStr
          ? chainStr.split(".").slice(-2, -1)[0]?.toLowerCase()   // "ws.close" → "ws"
          : chain && chain.length >= 2
            ? chain[chain.length - 2].toLowerCase()               // ["ws", "close"] → "ws"
            : undefined;

        if (
          memberName !== undefined &&
          // Common WebSocket instance variable names in TypeScript codebases
          (memberName === "ws" ||
            memberName === "websocket" ||
            memberName.endsWith("ws") ||
            memberName.startsWith("ws") ||
            memberName === "socket" ||
            memberName === "conn" ||
            memberName === "connection" ||
            memberName.includes("socket") ||
            memberName.includes("websocket") ||
            memberName.includes("streaming"))
        ) {
          trace.record(
            MATCHER_IDS.SUPPRESSION_PACKAGE_NOT_IMPORTED,
            "passed",
            `undici close() on member '${memberName}' — WebSocket/socket variable, not Dispatcher`,
          );
          continue;
        }
      }

      // undici response.json(): suppress response-json-parse-error in React component files
      // and Next.js App Router pages/layouts. These files run in Next.js's error boundary
      // context — uncaught exceptions render the nearest error.tsx boundary, not crash the
      // process. Requiring try-catch on every response.json() in a component is overly
      // prescriptive when the framework provides the error boundary.
      //
      // Additionally suppress in utility/hook wrapper files where the caller handles errors,
      // and in server-side API utility files (api/, analysis/, catalog/, lib/) where the
      // caller or framework handles errors at the orchestration layer.
      //
      // Evidence: concern-2026-04-11-undici-2 — 64 FP instances across React component files
      // (apps/web/components/**/*.tsx, apps/web/app/**/*.tsx, hooks/**/*.ts).
      // Evidence: concern-2026-04-20-undici-2 — 64 FP instances in server-side utility files
      // (api/analysis/post-game-analysis.ts, api/utils/ai-client.ts,
      //  lib/catalog/analyzeCatalogBatch.ts, lib/ai/generateArray.ts, hooks/useFileContent.ts).
      if (
        detection.packageName === "undici" &&
        postcondition.id === "response-json-parse-error"
      ) {
        const fileName = sourceFile.fileName;
        // React component files (.tsx) and Next.js app router pages
        const baseName = path.basename(fileName.replace(/\.tsx?$/, ""));
        if (
          /\.tsx$/.test(fileName) ||
          /[/\\]app[/\\]/.test(fileName) ||
          /^use[A-Z]/.test(baseName) ||
          // Hyphenated hook files (e.g., use-scan-poller.ts) in hooks/ directories
          // Evidence: concern-2026-04-15-undici-2 — use-scan-poller.ts not covered by camelCase check
          (/^use-/.test(baseName) && /[/\\]hooks?[/\\]/.test(fileName)) ||
          // components/ directory .ts files (client-side utility components)
          /[/\\]components?[/\\]/.test(fileName) ||
          // Server-side utility/wrapper files where caller handles errors
          // Evidence: concern-2026-04-20-undici-2 — api/analysis/, api/utils/, lib/catalog/, lib/ai/
          /[/\\](utils?|helpers?|analysis|catalog|lib|ai)[/\\]/i.test(fileName)
        ) {
          // WAVE-2F: undici response.json() in React component / Next.js
          // page / hook / utility — framework error boundary handles throws.
          trace.record(
            MATCHER_IDS.SUPPRESSION_FRAMEWORK_BOUNDARY,
            "passed",
            "undici response.json() in component/framework file — error boundary handles throws",
          );
          continue;
        }
      }

      // express: async-middleware-unhandled-rejection — extend suppression to files that
      // register a 4-argument Express error handler in the same file. Express's error
      // propagation pattern: async middleware throws → Express catches → routes to the
      // registered error handler. When the file itself defines the error handler
      // (e.g., app.use((err, req, res, next) => {...})), async middleware errors are handled.
      //
      // Additionally suppress when the file imports and uses an errorHandler middleware from
      // another module (common pattern: import errorHandler from './middleware/error').
      //
      // Evidence: concern-2026-04-11-express-13 — 5 FP instances in api/dev-server.ts and
      // api/browser-agent-server.ts (bootstrap files that register global error middleware).
      if (
        detection.packageName === "express" &&
        postcondition.id === "async-middleware-unhandled-rejection" &&
        ts.isCallExpression(detection.node)
      ) {
        const expressFileText = sourceFile.getFullText();
        // Check for 4-argument error handler signature (err, req, res, next)
        // or common error handler import patterns
        // WAVE-2B: 4-arg express error handler in the same file is a framework idiom
        // that satisfies async-middleware-unhandled-rejection — record passed.
        if (
          /\(\s*err[\s,]/.test(expressFileText) ||
          /errorHandler|error_handler|handleError/.test(expressFileText)
        ) {
          trace.record(
            MATCHER_IDS.FRAMEWORK_EXPRESS_ASYNC_ERRORS,
            "passed",
          );
          this.recordPassedSite(
            detection,
            sourceFile,
            postcondition.id,
            MATCHER_IDS.FRAMEWORK_EXPRESS_ASYNC_ERRORS,
          );
          continue; // File has error handler — async middleware errors are propagated to it
        }
      }

      // @supabase/supabase-js: rls-policy-violation — suppress in server-side bootstrap,
      // API server, and admin files that use the service role key (which bypasses RLS
      // intentionally). The service role is designed for admin/backend operations that
      // must bypass tenant isolation — firing rls-policy-violation here is always a FP.
      //
      // Also suppress in main.ts / server.ts / index.ts bootstrap files where Supabase
      // is initialized with service role for system-level operations.
      //
      // Evidence: concern-2026-04-11-supabase-supabase-js-23 — 1 FP: packages/api/src/main.ts:211
      // (express API server initialization; supabase service role client used for admin ops).
      if (
        detection.packageName === "@supabase/supabase-js" &&
        postcondition.id === "rls-policy-violation"
      ) {
        const fileName = sourceFile.fileName;
        const fileText = sourceFile.getFullText();
        // Suppress in bootstrap/server files
        if (
          /[/\\](main|server|index|app)\.(ts|tsx)$/.test(fileName) ||
          fileText.includes("SERVICE_ROLE") ||
          fileText.includes("service_role") ||
          fileText.includes("serviceRole") ||
          fileText.includes("SUPABASE_SERVICE_ROLE_KEY")
        ) {
          // WAVE-2F: supabase service-role context bypasses RLS by design —
          // rls-policy-violation is not applicable.
          trace.record(
            MATCHER_IDS.SUPPRESSION_FILE_SCOPE,
            "passed",
            "supabase service-role context — RLS intentionally bypassed",
          );
          continue;
        }
      }

      // ai (Vercel AI SDK): schema-validation-error — suppress when the generateObject call
      // is inside a utility/wrapper function that returns the result to its caller
      // (delegation pattern). Also suppress when inside a retry wrapper.
      // The schema-validation-error postcondition fires even when the calling function
      // is a thin wrapper that propagates errors to its callers for handling.
      //
      // Evidence: concern-2026-04-11-ai-24 — 1 FP: apps/web/utils/llms/index.ts:350
      // (utility function that wraps generateObject and returns result; caller handles errors).
      if (
        detection.packageName === "ai" &&
        postcondition.id === "schema-validation-error"
      ) {
        const fileName = sourceFile.fileName;
        // Suppress in utility/wrapper files (utils/, llms/, ai/)
        // but NOT in corpus fixture files (ground-truth.ts, fixtures/) — those are test files
        if (
          /[/\\](utils?|llms?|helpers?|lib|ai)[/\\]/i.test(fileName) &&
          !/[/\\]fixtures?[/\\]|ground-truth/.test(fileName)
        ) {
          // Check if enclosing function returns the result (delegation pattern)
          let cur: ts.Node | undefined = detection.node;
          let isInsideRegularFunction = false;
          while (cur) {
            if (
              ts.isFunctionDeclaration(cur) ||
              ts.isFunctionExpression(cur) ||
              ts.isArrowFunction(cur) ||
              ts.isMethodDeclaration(cur)
            ) {
              isInsideRegularFunction = true;
              break;
            }
            cur = cur.parent;
          }
          if (isInsideRegularFunction) {
            // WAVE-2F: ai schema-validation in a utility/wrapper file
            // (utils/, llms/, helpers/, lib/, ai/) — caller handles errors.
            trace.record(
              MATCHER_IDS.SUPPRESSION_RETURN_DELEGATE,
              "passed",
              "ai schema-validation in utility/wrapper file — caller handles errors",
            );
            continue;
          }
        }
      }

      // @clerk/nextjs: use-user-no-loaded-check — suppress in Next.js App Router
      // pages/layouts/components that are served only inside Clerk-protected routes.
      // The isLoaded check is enforced at the middleware/route level (middleware.ts + clerkMiddleware),
      // so components inside (auth)/**, (dashboard)/**, or similar protected route groups
      // can safely call useUser() without an inline isLoaded guard.
      // Also suppress in components that check auth at the page/server-component level.
      //
      // Evidence: concern-2026-04-13-clerk-nextjs-9 — 7 FPs:
      //   apps/web/components/layout/sidebar.tsx, header.tsx, top-nav.tsx (always rendered inside
      //   authenticated routes), apps/web/app/(dashboard)/**, apps/web/components/settings/**
      //   (protected-route-only components that get user from Clerk middleware).
      // Evidence: concern-2026-04-13-clerk-nextjs-1 — additional FPs:
      //   apps/web/app/(auth)/invite/[token]/page.tsx (auth route group also protected by middleware),
      //   apps/web/components/providers/analytics-provider.tsx (providers always inside ClerkProvider tree).
      if (
        detection.packageName === "@clerk/nextjs" &&
        postcondition.id === "use-user-no-loaded-check"
      ) {
        const fileName = sourceFile.fileName;
        const fileText = sourceFile.getFullText();
        // WAVE-2E: both suppression paths below indicate clerk-middleware-style
        // configuration — protected route group OR inline auth-state guards.
        // Local helper to avoid duplicating the trace.record + recordPassedSite
        // triplet on each short-circuit path (mirrors the WAVE-2B multi-path
        // helper convention).
        const recordPassedClerk = (): void => {
          trace.record(
            MATCHER_IDS.FRAMEWORK_CLERK_MIDDLEWARE_CONFIGURED,
            "passed",
          );
          this.recordPassedSite(
            detection,
            sourceFile,
            postcondition.id,
            MATCHER_IDS.FRAMEWORK_CLERK_MIDDLEWARE_CONFIGURED,
          );
        };
        // Suppress in protected route group files: (dashboard), (auth), (protected)
        if (
          /[/\\]\(dashboard\)[/\\]/.test(fileName) ||
          /[/\\]\(auth\)[/\\]/.test(fileName) ||
          /[/\\]\(protected\)[/\\]/.test(fileName) ||
          /[/\\](layout|sidebar|header|top-nav|nav)\.(tsx?|jsx?)$/.test(fileName) ||
          /[/\\](settings|profile)[/\\]/.test(fileName) ||
          /[/\\]providers?[/\\]/i.test(fileName)
        ) {
          recordPassedClerk();
          continue; // Protected route context — middleware enforces isLoaded
        }
        // Suppress when the component file also checks isLoaded somewhere (partial guards)
        if (fileText.includes("isLoaded") || fileText.includes("isSignedIn")) {
          recordPassedClerk();
          continue; // File has auth state checks present
        }
      }

      // stripe: rate-limit-error — suppress in Stripe client initialization files.
      // The Stripe SDK constructor (new Stripe(key, options)) does not make network calls —
      // it only creates a local client object. rate-limit-error can only occur at API call
      // sites (charges.create(), paymentIntents.create(), etc.), not at the constructor.
      // Files that only initialize and export the Stripe client (lib/stripe.ts, utils/stripe.ts)
      // should not fire rate-limit-error on the constructor call.
      //
      // Evidence: concern-2026-04-13-stripe-16 — 3 FPs: apps/web/lib/stripe.ts (client init module
      // that exports the Stripe singleton; only the constructor call is in this file).
      if (
        detection.packageName === "stripe" &&
        postcondition.id === "rate-limit-error" &&
        detection.functionName === "Stripe"
      ) {
        // WAVE-2F: Stripe constructor (new Stripe(key, options)) doesn't make
        // network calls — rate-limit-error is impossible at construction.
        trace.record(
          MATCHER_IDS.SUPPRESSION_NEVER_THROWS,
          "passed",
          "Stripe constructor — no network call, rate-limit impossible",
        );
        continue;
      }

      // @libsql/client: transaction-not-closed — suppress when tx.close() (or any
      // variable.close() call) is present in a finally block within the enclosing function.
      // The postcondition requires transaction.close() in a finally block; when the finally
      // block is present, the pattern is correct and no violation should fire.
      //
      // Pattern: const tx = await db.transaction("write"); try { ... } finally { tx.close(); }
      // The scanner's standard try-catch check fires on transaction() because the function is
      // not wrapped in a single outer try-catch — the finally block is the correct pattern here.
      //
      // Evidence: concern-20260417-libsql-client-deepen-1 — ground-truth fixture line 142:
      // transferFundsWithFinally() has tx.close() in finally but scanner still fires
      // transaction-not-closed.
      if (
        detection.packageName === "@libsql/client" &&
        primaryPostcondition.id === "transaction-not-closed"
      ) {
        // Walk up to find the enclosing function, then check if any finally block
        // within that function contains a .close() call.
        let enclosingFunc: ts.Node | undefined;
        let cur: ts.Node | undefined = detection.node.parent;
        while (cur) {
          if (
            ts.isFunctionDeclaration(cur) ||
            ts.isFunctionExpression(cur) ||
            ts.isArrowFunction(cur) ||
            ts.isMethodDeclaration(cur)
          ) {
            enclosingFunc = cur;
            break;
          }
          cur = cur.parent;
        }
        const scopeToCheck = enclosingFunc ?? sourceFile;
        let hasCloseInFinally = false;
        const checkForCloseInFinally = (node: ts.Node): void => {
          if (hasCloseInFinally) return;
          // Is this a Block that is the finallyBlock of a TryStatement?
          if (
            ts.isBlock(node) &&
            node.parent &&
            ts.isTryStatement(node.parent) &&
            node.parent.finallyBlock === node
          ) {
            // Check if this finally block contains a .close() call
            const findClose = (n: ts.Node): void => {
              if (
                ts.isCallExpression(n) &&
                ts.isPropertyAccessExpression(n.expression) &&
                n.expression.name.text === "close"
              ) {
                hasCloseInFinally = true;
                return;
              }
              if (!hasCloseInFinally) ts.forEachChild(n, findClose);
            };
            findClose(node);
            return;
          }
          ts.forEachChild(node, checkForCloseInFinally);
        };
        checkForCloseInFinally(scopeToCheck);
        if (hasCloseInFinally) {
          // WAVE-2C: finally { tx.close() } is the canonical FINALLY_TRANSACTION_CLOSE
          // guard for @libsql/client transaction-not-closed — record passed.
          trace.record(MATCHER_IDS.FINALLY_TRANSACTION_CLOSE, "passed");
          this.recordPassedSite(
            detection,
            sourceFile,
            primaryPostcondition.id,
            MATCHER_IDS.FINALLY_TRANSACTION_CLOSE,
          );
          continue; // finally { tx.close() } present — postcondition satisfied
        }
      }

      // axios: validateStatus option — suppress rate-limited-429 (and all HTTP-error
      // postconditions) when the caller passes validateStatus in the config argument.
      // When validateStatus is present (e.g. validateStatus: () => true, or
      // validateStatus: (s) => s < 600), axios resolves ALL status codes as success —
      // it never throws AxiosError for any HTTP status. The caller has explicitly opted
      // into manual status inspection (response.status) instead of exception handling.
      //
      // Config argument position by method:
      //   get/delete/head:  arguments[1]  (url, config)
      //   post/put/patch:   arguments[2]  (url, data, config)
      //   request:          arguments[0]  (config)
      //
      // Only the inline object literal pattern is detected. Variable references require
      // data-flow analysis and are out of scope (false negative is acceptable; the FP
      // burden from validateStatus is what motivated this concern).
      //
      // Evidence: concern-20260712-lead-12-axios-validate-status-exempt-429
      //   hoppscotch: axios.get(url, { validateStatus: () => true }) fires rate-limited-429
      //   even though the caller explicitly handles all status codes via response.status.
      if (
        detection.packageName === "axios" &&
        ts.isCallExpression(detection.node) &&
        (postcondition.id.includes("rate-limit") ||
          postcondition.id.includes("429") ||
          postcondition.id === "error-4xx-5xx" ||
          postcondition.id === "patch-error-4xx-5xx" ||
          postcondition.id === "head-error-4xx-5xx" ||
          postcondition.id === "postform-error-4xx-5xx" ||
          postcondition.id === "putform-error-4xx-5xx" ||
          postcondition.id === "patchform-error-4xx-5xx" ||
          postcondition.id === "query-error-4xx-5xx")
      ) {
        const axiosArgs = detection.node.arguments;
        // Determine config argument index based on function name
        const configArgIdx =
          detection.functionName === "request" ||
          detection.functionName === "default"
            ? 0  // axios.request(config), direct axios({...}) call
            : detection.functionName === "get" ||
                detection.functionName === "delete" ||
                detection.functionName === "head"
              ? 1  // axios.get(url, config)
              : 2; // axios.post/put/patch(url, data, config)
        const configArg =
          configArgIdx < axiosArgs.length
            ? axiosArgs[configArgIdx]
            : undefined;
        // Also check argument index 0 if method is indeterminate (e.g. instance methods)
        const configArgToCheck =
          configArg ?? (axiosArgs.length === 1 ? axiosArgs[0] : undefined);
        if (
          configArgToCheck &&
          ts.isObjectLiteralExpression(configArgToCheck) &&
          configArgToCheck.properties.some(
            (p): p is ts.PropertyAssignment =>
              ts.isPropertyAssignment(p) &&
              ts.isIdentifier(p.name) &&
              p.name.text === "validateStatus",
          )
        ) {
          trace.record(
            MATCHER_IDS.SUPPRESSION_OPTION_SUPPRESSES,
            "passed",
            "axios validateStatus option present — all HTTP status codes resolved as success, postcondition cannot fire",
          );
          this.recordPassedSite(
            detection,
            sourceFile,
            postcondition.id,
            MATCHER_IDS.SUPPRESSION_OPTION_SUPPRESSES,
          );
          continue;
        }
      }

      // Get location
      const { line, column } = this.getLocation(detection.node, sourceFile);

      // Build code context
      const { json: codeContext, startLine: codeContextStartLine } =
        this.buildCodeContext(sourceFile, line - 1);

      // Compute fingerprint (matches SaaS computation for cross-reference)
      const fingerprint = computeViolationFingerprint({
        packageName: detection.packageName,
        postconditionId: postcondition.id,
        filePath: sourceFile.fileName,
        lineNumber: line,
        callExpression: detection.functionName,
      });

      // Check suppression (suppression store checked first, then inline, then config)
      const suppressionResult = checkSuppression({
        projectRoot: this.options.projectRoot,
        sourceFile,
        line,
        column,
        packageName: detection.packageName,
        postconditionId: postcondition.id,
        analyzerVersion: this.options.analyzerVersion || "2.0.0",
        updateManifest: false,
        fingerprint,
      });

      // Build subViolations from remaining postconditions (not the primary).
      // When we resolved a command-specific postcondition (e.g. S3 send()), the other
      // postconditions belong to different command types — omit them as sub-violations.
      const subViolations = postconditionResolved
        ? []
        : postconditions
            .filter((p) => p.id !== postcondition.id)
            .map((p) => ({
              postconditionId: p.id,
              message: p.throws
                ? `Also missing: ${p.throws}`
                : `Also missing: ${p.returns || p.condition || p.id}`,
              severity: p.severity as "error" | "warning",
            }));

      const violation: Violation = {
        file: sourceFile.fileName,
        line,
        column,
        package: detection.packageName,
        function: detection.functionName,
        postconditionId: postcondition.id,
        severity: postcondition.severity as "error" | "warning",
        message: postcondition.throws
          ? `No try-catch block found. ${postcondition.throws} - this will crash the application.`
          : `No error handling found. ${postcondition.returns || postcondition.condition || postcondition.id} — required handling missing.`,
        codeContext,
        codeContextStartLine,
        inTryCatch: false,
        suppressed: suppressionResult.suppressed,
        suppressionReason: suppressionResult.suppressed
          ? suppressionResult.source
          : undefined,
        fingerprint,
        callExpression: detection.functionName,
        business_impact: postcondition.business_impact,
        subViolations: subViolations.length > 0 ? subViolations : undefined,
        // WAVE-2A: serialize the per-callsite detection trace immediately
        // before push. serialize() emits recorded passed/failed entries in
        // insertion order, then fills not_applicable for registered-applicable
        // matchers that were never recorded (consults applicabilityPredicate
        // from MATCHER_IDS registry; encodes Pitfall 7 sentry-lifecycle gating).
        // PH1-R2 (every violation has a non-empty detectionTrace) GREENs here.
        detectionTrace: trace.serialize(),
      };

      violations.push(violation);
    }

    return violations;
  }

  /** HTTP client packages where catch-block completeness checks apply. */
  private static readonly HTTP_CLIENTS = new Set([
    "axios",
    "node-fetch",
    "got",
    "superagent",
    "request",
    "ky",
    "undici",
  ]);

  /**
   * WAVE-2B (Plan 01-04), renamed WAVE-2C (Plan 01-05) from FRAMEWORK_PACKAGES
   * → PASSING_SITE_PACKAGES because the set now includes DB drivers and other
   * non-framework families. Packages that participate in passing-site capture
   * for the Wave 9 convention-miner. When a suppression guard short-circuits
   * with a `passed` matcher record, the call site is buffered into
   * _lastPassedDetections so the miner can read across files. Plans 01-06..01-08
   * widen this set with their additional package families (AWS SDK, lifecycle,
   * long-tail).
   */
  private static readonly PASSING_SITE_PACKAGES = new Set([
    // WAVE-2B (Plan 01-04) — framework families
    "express",
    "fastify",
    "react-hook-form",
    "@tanstack/react-query",
    "react-query",
    "@apollo/server",
    // WAVE-2C (Plan 01-05) — DB-driver families
    "knex",
    "typeorm",
    "prisma",
    "@prisma/client",
    "@libsql/client",
    "drizzle-orm",
    "mongoose",
    "pg",
    "mysql2",
    // WAVE-2D (Plan 01-06) — AWS SDK families. Each @aws-sdk/* package's
    // send() / upload() / invokeModel() calls flow through the canonical
    // OR-chain (Plan 01-03, line ~2277). When TRY_CATCH_DIRECT or another
    // passing matcher short-circuits, the AWS-specific
    // recordAwsCommandPassedSite() helper records the per-command matcher
    // (e.g. aws:s3-command + aws:s3-command:GetObjectCommand) and pushes
    // via recordPassedSite() so the Wave 9 convention miner can spot
    // "this repo wraps all S3 calls" or "all SQS receives" patterns.
    "@aws-sdk/client-s3",
    "@aws-sdk/client-ses",
    "@aws-sdk/client-sesv2",
    "@aws-sdk/client-sqs",
    "@aws-sdk/client-sns",
    "@aws-sdk/client-dynamodb",
    "@aws-sdk/client-secrets-manager",
    "@aws-sdk/client-bedrock-runtime",
    "@aws-sdk/client-lambda",
    "@aws-sdk/client-cloudwatch-logs",
    "@aws-sdk/lib-storage",
    "@aws-sdk/s3-request-presigner",
    // WAVE-2E (Plan 01-07) — lifecycle-special families. Sentry
    // startSpanManual/startInactiveSpan suppression branches record
    // FINALLY_SPAN_END when the try/finally { span.end() } pattern fires;
    // Clerk middleware/provider suppression branches record
    // FRAMEWORK_CLERK_MIDDLEWARE_CONFIGURED when the project-wide
    // configuration probe succeeds; puppeteer close-in-catch-or-finally
    // suppression branches record FINALLY_CLOSE when the cleanup pattern
    // fires. All three families participate in passing-site capture for the
    // Wave 9 convention miner so cross-file conventions become minable.
    "@sentry/node",
    "@sentry/nextjs",
    "@sentry/browser",
    "@sentry/react",
    "@sentry/electron",
    "@clerk/nextjs",
    "puppeteer",
  ]);

  /**
   * Check whether a catch block properly handles the specific error patterns required
   * by the postconditions. Returns a warning-level violation if the catch block is
   * incomplete, or null if handling is adequate.
   *
   * Mirrors v1's postcondition-specific catch analysis:
   *   - 429/rate-limit postconditions → warn if no 429 handling and no retry logic
   *   - network postconditions → warn if HTTP client and no error.response null-check
   *   - error postconditions → warn if HTTP client and no status code inspection
   */
  private checkCatchBlockCompleteness(
    detection: Detection,
    postconditions: Postcondition[],
    catchClause: ts.CatchClause,
    sourceFile: ts.SourceFile,
  ): Violation | null {
    const pkg = detection.packageName;
    const isHttpClient = ContractMatcher.HTTP_CLIENTS.has(pkg);
    const checksResponse =
      this.controlFlow.catchChecksResponseExists(catchClause);
    const checksStatus = this.controlFlow.catchChecksStatusCode(catchClause);
    const handledCodes =
      this.controlFlow.extractHandledStatusCodes(catchClause);
    const hasRetry = this.controlFlow.catchHasRetryLogic(catchClause);

    // If the catch block already has adequate handling (returns fallback, rethrows,
    // logs, or is empty-catch intentional swallow), suppress "generic error handling"
    // warnings. The developer made a conscious choice — no need for more specificity.
    // Evidence: civitai audit 2026-05-05 — 12 undici FPs from adequate catch blocks.
    const hasAdequateHandling =
      this.controlFlow.catchHasAdequateHandling(catchClause);

    let matchedPostcondition: Postcondition | null = null;
    let message = "";

    // Check each postcondition for incomplete handling
    for (const pc of postconditions) {
      const id = pc.id.toLowerCase();

      if (
        id.includes("429") ||
        id.includes("rate-limit") ||
        id.includes("rate_limit")
      ) {
        // ai (Vercel AI SDK): the SDK has built-in retry logic (maxRetries defaults to 2).
        // A catch block on an ai call already satisfies the postcondition — we should not
        // warn about missing retry logic because the SDK handles it automatically.
        // Evidence: concern-20260402-ai-1 — users correctly report that catch block is
        // sufficient; explicit retry logic is not required when the SDK already retries.
        if (pkg === "ai") {
          continue;
        }
        if (!handledCodes.includes(429) && !hasRetry) {
          // Check if any satisfying_patterns (instanceof) are present in the catch block.
          // An explicit `instanceof Stripe.errors.StripeRateLimitError` satisfies this postcondition.
          if (pc.satisfying_patterns?.length) {
            const satisfied = pc.satisfying_patterns.some(
              (sp) =>
                sp.instanceof &&
                this.catchHasInstanceofPattern(catchClause, sp.instanceof),
            );
            if (satisfied) {
              continue; // instanceof pattern found — postcondition is satisfied
            }
          }
          matchedPostcondition = pc;
          message =
            "Rate limit response (429) is not explicitly handled. Consider implementing retry logic with exponential backoff.";
          break;
        }
      } else if (id.includes("network")) {
        if (isHttpClient && !checksResponse && !hasAdequateHandling) {
          matchedPostcondition = pc;
          message =
            "Generic error handling found. Consider checking if error.response exists to distinguish network failures from HTTP errors.";
          break;
        }
      } else if (pc.severity === "error") {
        if (isHttpClient && !checksStatus && !hasAdequateHandling) {
          // For undici/fetch response-json-parse-error: the idiomatic pattern is to check
          // response.ok or response.status BEFORE calling .json() (not inside the catch block).
          // If the detection node is inside an if (res.ok) or if (res.status === 200) guard,
          // the postcondition is satisfied — the status was checked before the .json() call.
          // This differs from the axios pattern where status is checked inside catch.
          //
          // Evidence: concern-20260429-undici-generic-error-handling-false-positive —
          // nark's own auth.ts has: if (res.status === 200) { try { await res.json() } catch (e) {...} }
          // The outer status guard satisfies response-json-parse-error but the analyzer only
          // checked inside the catch block.
          if (
            (pkg === "undici" || pkg === "node-fetch" || pkg === "got" || pkg === "ky") &&
            pc.id === "response-json-parse-error" &&
            this.controlFlow.isNodeInsideResponseOkGuard(detection.node)
          ) {
            continue; // Status was checked before .json() — fetch idiom satisfied
          }
          matchedPostcondition = pc;
          message =
            "Generic error handling found. Consider inspecting error.response.status to distinguish between 4xx client errors and 5xx server errors.";
          break;
        }
      }
    }

    if (!matchedPostcondition) return null;

    const { line, column } = this.getLocation(detection.node, sourceFile);
    const { json: codeContext, startLine: codeContextStartLine } =
      this.buildCodeContext(sourceFile, line - 1);

    const fingerprint = computeViolationFingerprint({
      packageName: pkg,
      postconditionId: matchedPostcondition.id,
      filePath: sourceFile.fileName,
      lineNumber: line,
      callExpression: detection.functionName,
    });

    const suppressionResult = checkSuppression({
      projectRoot: this.options.projectRoot,
      sourceFile,
      line,
      column,
      packageName: pkg,
      postconditionId: matchedPostcondition.id,
      analyzerVersion: this.options.analyzerVersion || "2.0.0",
      updateManifest: false,
      fingerprint,
    });

    return {
      file: sourceFile.fileName,
      line,
      column,
      package: pkg,
      function: detection.functionName,
      postconditionId: matchedPostcondition.id,
      severity: "warning",
      message,
      codeContext,
      codeContextStartLine,
      inTryCatch: true,
      suppressed: suppressionResult.suppressed,
      suppressionReason: suppressionResult.suppressed
        ? suppressionResult.source
        : undefined,
      fingerprint,
      callExpression: detection.functionName,
      business_impact: matchedPostcondition.business_impact,
    };
  }

  /**
   * Handle a missing-event-listener absence detection.
   *
   * These are generated by EventListenerAbsencePlugin after file traversal.
   * The detection metadata contains: { missingEvent, postconditionId }.
   * Unlike regular violations, we skip the try-catch check since this is
   * about a missing registration, not an unhandled exception.
   */
  private handleMissingEventListener(
    detection: Detection,
    sourceFile: ts.SourceFile,
  ): Violation | null {
    const contract = this.contracts.get(detection.packageName);
    if (!contract) return null;

    const funcContract = this.findFunctionContract(
      contract,
      detection.functionName,
    );
    if (!funcContract) return null;

    // Find postcondition: prefer the one with matching ID, fall back to first error severity
    const postconditions = (funcContract.postconditions || []).filter(
      (p) => p.severity === "error" || p.severity === "warning",
    );
    if (postconditions.length === 0) return null;

    const targetId = detection.metadata?.postconditionId as string | undefined;
    const postcondition =
      (targetId ? postconditions.find((p) => p.id === targetId) : undefined) ??
      postconditions[0];

    // ioredis: suppress missing-error-listener when the Redis instance is a module-level
    // exported singleton. In this pattern, .on('error') is typically registered in a
    // separate initialization/bootstrap module that imports the singleton. The scanner
    // cannot trace cross-file event listener registration.
    //
    // Detection: the factory call node's ancestor chain reaches a VariableDeclaration
    // at the SourceFile level (top-level) and the VariableStatement is exported.
    //
    // Evidence: concern-2026-04-02-ioredis-1 (2 FPs: lib/auth-cache.ts, lib/rate-limit.ts —
    //           both export a Redis singleton; .on('error') is in a boot/init module).
    if (detection.packageName === "ioredis") {
      let cur: ts.Node | undefined = detection.node.parent;
      while (cur) {
        if (ts.isVariableDeclaration(cur)) {
          // Check if this variable declaration is at the module (SourceFile) level
          const varDeclList = cur.parent;
          if (varDeclList && ts.isVariableDeclarationList(varDeclList)) {
            const varStmt = varDeclList.parent;
            if (
              varStmt &&
              ts.isVariableStatement(varStmt) &&
              ts.isSourceFile(varStmt.parent)
            ) {
              // Top-level variable — suppress regardless of export status.
              // Module-level Redis instances are shared singletons and their
              // error listeners are registered in initialization modules.
              return null;
            }
          }
          break;
        }
        // Stop climbing at function boundaries
        if (
          ts.isFunctionDeclaration(cur) ||
          ts.isFunctionExpression(cur) ||
          ts.isArrowFunction(cur) ||
          ts.isMethodDeclaration(cur) ||
          ts.isClassDeclaration(cur)
        ) {
          break;
        }
        cur = cur.parent;
      }
    }

    const { line, column } = this.getLocation(detection.node, sourceFile);
    const { json: codeContext, startLine: codeContextStartLine } =
      this.buildCodeContext(sourceFile, line - 1);

    const missingEvent =
      (detection.metadata?.missingEvent as string) ?? "error";
    const message = `Missing .on('${missingEvent}', handler) — crashes the process on any unhandled error.`;

    const fingerprint = computeViolationFingerprint({
      packageName: detection.packageName,
      postconditionId: postcondition.id,
      filePath: sourceFile.fileName,
      lineNumber: line,
      callExpression: detection.functionName,
    });

    const suppressionResult = checkSuppression({
      projectRoot: this.options.projectRoot,
      sourceFile,
      line,
      column,
      packageName: detection.packageName,
      postconditionId: postcondition.id,
      analyzerVersion: this.options.analyzerVersion || "2.0.0",
      updateManifest: false,
      fingerprint,
    });

    return {
      file: sourceFile.fileName,
      line,
      column,
      package: detection.packageName,
      function: detection.functionName,
      postconditionId: postcondition.id,
      severity: postcondition.severity as "error" | "warning",
      message,
      codeContext,
      codeContextStartLine,
      inTryCatch: false,
      suppressed: suppressionResult.suppressed,
      suppressionReason: suppressionResult.suppressed
        ? suppressionResult.source
        : undefined,
      fingerprint,
      callExpression: detection.functionName,
      business_impact: postcondition.business_impact,
    };
  }

  /**
   * Handle a Bedrock stream chunk missing-error-field detection.
   *
   * Generated by BedrockStreamChunkDetector.afterTraversal() when a for-await-of
   * loop over InvokeModelWithResponseStreamCommand response.body does not check all
   * six required stream-error event fields per chunk.
   *
   * The detection metadata contains:
   *   { postconditionId, missingFields, responseVarName, chunkVarName }
   *
   * Like missing-event-listener, we bypass the normal try-catch check — this is
   * about missing property access checks inside the loop body, not about whether
   * the loop itself is wrapped in a try-catch.
   */
  private handleBedrockStreamChunkMissing(
    detection: Detection,
    sourceFile: ts.SourceFile,
  ): Violation | null {
    const contract = this.contracts.get(detection.packageName);
    if (!contract) return null;

    const funcContract = this.findFunctionContract(
      contract,
      detection.functionName,
    );
    if (!funcContract) return null;

    const targetId = detection.metadata?.postconditionId as string | undefined;
    const postconditions = (funcContract.postconditions || []).filter(
      (p) => p.severity === "error" || p.severity === "warning",
    );
    if (postconditions.length === 0) return null;

    const postcondition =
      (targetId ? postconditions.find((p) => p.id === targetId) : undefined) ??
      postconditions[0];
    if (!postcondition) return null;

    const { line, column } = this.getLocation(detection.node, sourceFile);
    const { json: codeContext, startLine: codeContextStartLine } =
      this.buildCodeContext(sourceFile, line - 1);

    const missingFields = (detection.metadata?.missingFields as string[] | undefined) ?? [];
    const chunkVarName = (detection.metadata?.chunkVarName as string | undefined) ?? "chunk";
    const message =
      `for await (const ${chunkVarName} of response.body) missing per-chunk error field checks` +
      (missingFields.length > 0 ? `: ${missingFields.join(", ")}` : "") +
      ". Stream errors will be silently swallowed.";

    const fingerprint = computeViolationFingerprint({
      packageName: detection.packageName,
      postconditionId: postcondition.id,
      filePath: sourceFile.fileName,
      lineNumber: line,
      callExpression: detection.functionName,
    });

    const suppressionResult = checkSuppression({
      projectRoot: this.options.projectRoot,
      sourceFile,
      line,
      column,
      packageName: detection.packageName,
      postconditionId: postcondition.id,
      analyzerVersion: this.options.analyzerVersion || "2.0.0",
      updateManifest: false,
      fingerprint,
    });

    return {
      file: sourceFile.fileName,
      line,
      column,
      package: detection.packageName,
      function: detection.functionName,
      postconditionId: postcondition.id,
      severity: postcondition.severity as "error" | "warning",
      message,
      codeContext,
      codeContextStartLine,
      inTryCatch: false,
      suppressed: suppressionResult.suppressed,
      suppressionReason: suppressionResult.suppressed
        ? suppressionResult.source
        : undefined,
      fingerprint,
      callExpression: detection.functionName,
      business_impact: postcondition.business_impact,
    };
  }

  /**
   * next package: deepen-stream-3 special pattern handler (2026-06-29).
   *
   * Handles 8 postconditions added in next contract v1.2.0 that have INVERSE or
   * context-dependent detection semantics:
   *
   * INVERSE (fire when INSIDE try-catch, not outside):
   *   forbidden-inside-try-catch  — forbidden() swallowed by catch → 403 never renders
   *   unauthorized-inside-try-catch — unauthorized() swallowed by catch → 401 never renders
   *
   * MISSING AWAIT (fire when NOT awaited):
   *   connection-missing-await — unawaited connection() = dynamic boundary never set
   *   draft-mode-missing-await — unawaited draftMode() = isEnabled always undefined
   *
   * CONTEXT DETECTION (fire based on call location):
   *   connection-inside-after — connection() inside after() throws E827 at runtime
   *   after-error-swallowed — after() callback body lacks try-catch = silent failures
   *   update-tag-after-redirect — updateTag() after redirect() = dead code
   *   update-tag-outside-server-action — updateTag() in Route Handler = throws
   *
   * Returns the Violation to push, or null if the pattern is NOT violated (caller skips).
   * Called unconditionally for the 6 function names above; handles all postconditions.
   */
  private handleNextSpecialPatterns(
    detection: Detection,
    sourceFile: ts.SourceFile,
  ): Violation | null {
    const contract = this.contracts.get("next");
    if (!contract) return null;

    const fnName = detection.functionName;
    const node = detection.node;

    // ── Pattern helpers ──────────────────────────────────────────────────────

    /** Build a Violation for the given postcondition ID on this detection. */
    const buildViolation = (postconditionId: string, customMessage?: string): Violation | null => {
      const funcContract = this.findFunctionContract(contract, fnName);
      if (!funcContract) return null;
      const pc = (funcContract.postconditions || []).find(
        (p) => p.id === postconditionId,
      );
      if (!pc) return null;

      const { line, column } = this.getLocation(node, sourceFile);
      const { json: codeContext, startLine: codeContextStartLine } =
        this.buildCodeContext(sourceFile, line - 1);

      const fingerprint = computeViolationFingerprint({
        packageName: "next",
        postconditionId: pc.id,
        filePath: sourceFile.fileName,
        lineNumber: line,
        callExpression: fnName,
      });

      const suppressionResult = checkSuppression({
        projectRoot: this.options.projectRoot,
        sourceFile,
        line,
        column,
        packageName: "next",
        postconditionId: pc.id,
        analyzerVersion: this.options.analyzerVersion || "2.0.0",
        updateManifest: false,
        fingerprint,
      });

      const message = customMessage ??
        (pc.throws
          ? `${fnName}() pattern violation: ${pc.id}. ${pc.throws}`
          : `${fnName}() pattern violation: ${pc.id}. ${pc.condition ?? pc.id}`);

      return {
        file: sourceFile.fileName,
        line,
        column,
        package: "next",
        function: fnName,
        postconditionId: pc.id,
        severity: pc.severity as "error" | "warning",
        message,
        codeContext,
        codeContextStartLine,
        inTryCatch: false,
        suppressed: suppressionResult.suppressed,
        suppressionReason: suppressionResult.suppressed
          ? suppressionResult.source
          : undefined,
        fingerprint,
        callExpression: fnName,
        business_impact: pc.business_impact,
      };
    };

    /** Check if this node is directly inside an after() callback argument. */
    const isInsideAfterCallback = (): boolean => {
      let current: ts.Node | undefined = node.parent;
      while (current) {
        // We're looking for a function expression/arrow function that is the argument to after()
        if (
          (ts.isArrowFunction(current) || ts.isFunctionExpression(current)) &&
          current.parent &&
          ts.isCallExpression(current.parent)
        ) {
          const callExpr = current.parent as ts.CallExpression;
          // Check if the call is after() — direct identifier
          if (
            ts.isIdentifier(callExpr.expression) &&
            callExpr.expression.text === "after"
          ) {
            // Check that our node is in the arguments list (i.e., is the callback)
            return callExpr.arguments.some((arg) => arg === current);
          }
        }
        // Stop traversal at function boundaries (don't escape enclosing functions)
        if (
          ts.isFunctionDeclaration(current) ||
          ts.isMethodDeclaration(current)
        ) {
          break;
        }
        current = current.parent;
      }
      return false;
    };

    /** Check if call node is awaited. */
    const isCallAwaited = (): boolean => {
      if (!ts.isCallExpression(node)) return false;
      return ts.isAwaitExpression(node.parent);
    };

    /** Get the enclosing function-like node for the detection. */
    const getEnclosingFunction = (): ts.FunctionLikeDeclaration | null => {
      let current: ts.Node | undefined = node.parent;
      while (current) {
        if (
          ts.isFunctionDeclaration(current) ||
          ts.isArrowFunction(current) ||
          ts.isFunctionExpression(current) ||
          ts.isMethodDeclaration(current)
        ) {
          return current as ts.FunctionLikeDeclaration;
        }
        current = current.parent;
      }
      return null;
    };

    /** Check if the enclosing function has a 'use server' directive. */
    const enclosingFunctionHasUseServer = (): boolean => {
      const fn = getEnclosingFunction();
      if (!fn) return false;
      const body = (fn as { body?: ts.Node }).body;
      if (!body || !ts.isBlock(body)) return false;
      for (const stmt of body.statements) {
        if (ts.isExpressionStatement(stmt)) {
          const expr = stmt.expression;
          if (ts.isStringLiteral(expr) && expr.text === "use server") {
            return true;
          }
        }
        // Directives only appear at the top of the function body — stop after first non-directive
        break;
      }
      return false;
    };

    /** Check if a 'redirect()' call (from next/navigation) appears before this node
     *  in the same immediate function scope (same containing function body). */
    const redirectAppearsBeforeInSameScope = (): boolean => {
      const fn = getEnclosingFunction();
      if (!fn) return false;
      const body = (fn as { body?: ts.Node }).body;
      if (!body || !ts.isBlock(body)) return false;
      let foundRedirect = false;
      const nodeStart = node.getStart(sourceFile);
      for (const stmt of body.statements) {
        // Walk each top-level statement looking for redirect() calls
        const stmtStart = stmt.getStart(sourceFile);
        if (stmtStart >= nodeStart) break; // we've passed the updateTag() call
        const hasRedirect = (n: ts.Node): boolean => {
          if (
            ts.isCallExpression(n) &&
            ts.isIdentifier(n.expression) &&
            n.expression.text === "redirect"
          ) {
            return true;
          }
          return ts.forEachChild(n, hasRedirect) ?? false;
        };
        if (hasRedirect(stmt)) {
          foundRedirect = true;
          break;
        }
      }
      return foundRedirect;
    };

    /** Check if the after() callback's body lacks a try-catch at the top level. */
    const afterCallbackLacksTryCatch = (): boolean => {
      if (!ts.isCallExpression(node)) return false;
      // The first argument to after() is the callback
      const callNode = node as ts.CallExpression;
      const callbackArg = callNode.arguments[0];
      if (!callbackArg) return false;
      // Check if it is wrapped in try-catch
      return !this.controlFlow.isCallbackBodyFullyWrappedInTryCatch(callNode, 0);
    };

    // ── Dispatch by function name ─────────────────────────────────────────────

    // concern-20260712-lead-03-nextjs-redirect-inside-try-catch-inverted:
    // redirect(), notFound(), and permanentRedirect() work by THROWING control-flow
    // exceptions (NEXT_REDIRECT / NEXT_HTTP_ERROR_FALLBACK). The violation is when they
    // ARE inside a try-catch (the catch swallows the throw, so the redirect/404 never
    // executes). The correct usage is to call them OUTSIDE try-catch. Fire ONLY when
    // isInTryCatch() is true; return null when outside try-catch (correct usage).
    // Previously these fell through to the standard "fire when outside try-catch" flow,
    // generating FPs on every correct call site. Fixed 2026-07-11.

    if (fnName === "redirect") {
      // redirect-inside-try-catch: fire when IS in try-catch
      if (this.controlFlow.isInTryCatch(node)) {
        return buildViolation(
          "redirect-inside-try-catch",
          "redirect() is inside a try-catch block — the catch intercepts the RedirectError (digest: NEXT_REDIRECT;...) and the redirect never executes. Call redirect() outside the try block or re-throw isRedirectError(e) when caught.",
        );
      }
      return null; // correct usage: redirect() outside try-catch
    }

    if (fnName === "notFound") {
      // not-found-inside-try-catch: fire when IS in try-catch
      if (this.controlFlow.isInTryCatch(node)) {
        return buildViolation(
          "not-found-inside-try-catch",
          "notFound() is inside a try-catch block — the catch intercepts the HTTPAccessFallbackError (digest: NEXT_HTTP_ERROR_FALLBACK;404) and the 404 page never renders. Call notFound() outside the try block or re-throw isHTTPAccessFallbackError(e) when caught.",
        );
      }
      return null; // correct usage: notFound() outside try-catch
    }

    if (fnName === "permanentRedirect") {
      // permanent-redirect-inside-try-catch: fire when IS in try-catch
      if (this.controlFlow.isInTryCatch(node)) {
        return buildViolation(
          "permanent-redirect-inside-try-catch",
          "permanentRedirect() is inside a try-catch block — the catch intercepts the RedirectError (digest: NEXT_REDIRECT;...;308;) and the 308 redirect never executes. Call permanentRedirect() outside the try block or re-throw isRedirectError(e) when caught.",
        );
      }
      return null; // correct usage: permanentRedirect() outside try-catch
    }

    if (fnName === "forbidden") {
      // forbidden-inside-try-catch: fire when IS in try-catch
      if (this.controlFlow.isInTryCatch(node)) {
        return buildViolation(
          "forbidden-inside-try-catch",
          "forbidden() is inside a try-catch block — the catch intercepts the 403 throw and the 403 page never renders, silently bypassing the authorization check.",
        );
      }
      return null; // correct usage: forbidden() outside try-catch
    }

    if (fnName === "unauthorized") {
      // unauthorized-inside-try-catch: fire when IS in try-catch
      if (this.controlFlow.isInTryCatch(node)) {
        return buildViolation(
          "unauthorized-inside-try-catch",
          "unauthorized() is inside a try-catch block — the catch intercepts the 401 throw and the 401 page never renders, silently serving content to unauthenticated users.",
        );
      }
      return null; // correct usage: unauthorized() outside try-catch
    }

    if (fnName === "connection") {
      // connection-inside-after: fire when connection() is called inside an after() callback
      if (isInsideAfterCallback()) {
        return buildViolation(
          "connection-inside-after",
          "connection() is called inside an after() callback — after() executes post-response so the dynamic-boundary signal is meaningless and Next.js throws E827 at runtime.",
        );
      }
      // connection-missing-await: fire when connection() is called without await
      if (!isCallAwaited()) {
        return buildViolation(
          "connection-missing-await",
          "connection() is called without await — the returned Promise is dropped, the dynamic-rendering boundary is never signalled, and the route may be prerendered with stale data.",
        );
      }
      return null; // correct: await connection() outside after()
    }

    if (fnName === "draftMode") {
      // draft-mode-missing-await: fire when draftMode() is called without await
      if (!isCallAwaited()) {
        return buildViolation(
          "draft-mode-missing-await",
          "draftMode() is called without await — the returned Promise is accessed directly, so isEnabled is always undefined and draft content is never shown.",
        );
      }
      return null; // correct: await draftMode()
    }

    if (fnName === "after") {
      // after-error-swallowed: fire when the callback body is not wrapped in try-catch
      if (afterCallbackLacksTryCatch()) {
        return buildViolation(
          "after-error-swallowed",
          "The after() callback body has no try-catch — errors in the post-response phase are silently swallowed and never surface in error monitoring.",
        );
      }
      return null; // correct: callback is wrapped in try-catch
    }

    if (fnName === "updateTag") {
      // update-tag-after-redirect: fire when redirect() appears before updateTag() in the same scope
      if (redirectAppearsBeforeInSameScope()) {
        return buildViolation(
          "update-tag-after-redirect",
          "updateTag() appears after redirect() in the same function scope — redirect() throws RedirectError immediately, so updateTag() is dead code that never executes.",
        );
      }
      // update-tag-outside-server-action: fire when updateTag() is NOT in a Server Action
      // A Server Action must have a 'use server' directive at the top of the function body.
      // Route Handlers (export async function POST/GET/etc) do NOT have 'use server' directives.
      if (!enclosingFunctionHasUseServer()) {
        return buildViolation(
          "update-tag-outside-server-action",
          "updateTag() is called outside a Server Action — it must only be called from functions with a 'use server' directive. Route Handlers should use revalidateTag() instead.",
        );
      }
      return null; // correct: updateTag() in a Server Action before any redirect()
    }

    // concern-20260712-lead-08: revalidatePath and revalidateTag after redirect.
    // The contract postconditions revalidate-after-redirect and revalidate-tag-after-redirect
    // describe dead-code placement (revalidate called AFTER redirect() which throws first).
    // The standard try-catch matcher fires these on ANY bare revalidatePath/revalidateTag call
    // because the postcondition `throws` field is populated (with redirect's throw, not their own).
    // Fix: only fire when redirect() actually appears before the revalidate call in the same scope.
    // If no redirect() is present, the call is correct (revalidate without redirect = fine).
    if (fnName === "revalidatePath") {
      if (redirectAppearsBeforeInSameScope()) {
        return buildViolation(
          "revalidate-after-redirect",
          "revalidatePath() appears after redirect() in the same function scope — redirect() throws RedirectError immediately, so revalidatePath() is dead code that never executes. Call revalidatePath() BEFORE redirect().",
        );
      }
      return null; // correct: revalidatePath() before redirect(), or no redirect in scope
    }

    if (fnName === "revalidateTag") {
      // revalidate-tag-after-redirect: only fire when redirect() precedes this call
      if (redirectAppearsBeforeInSameScope()) {
        return buildViolation(
          "revalidate-tag-after-redirect",
          "revalidateTag() appears after redirect() in the same function scope — redirect() throws RedirectError immediately, so revalidateTag() is dead code that never executes. Call revalidateTag() BEFORE redirect().",
        );
      }
      // revalidate-tag-deprecated-single-arg: fire when called with exactly one argument.
      // This postcondition applies to all revalidateTag() calls regardless of redirect presence.
      // Since we intercept all revalidateTag detections here (to suppress the revalidate-after-redirect
      // FP), we must also handle this postcondition to avoid silently dropping it.
      // The check: call has exactly 1 argument (the deprecated form) vs 2+ (the current form).
      if (
        ts.isCallExpression(node) &&
        node.arguments.length === 1
      ) {
        return buildViolation(
          "revalidate-tag-deprecated-single-arg",
          "revalidateTag() called with one argument — the single-arg form is deprecated in Next.js 16. Use revalidateTag(tag, 'max') for stale-while-revalidate semantics or revalidateTag(tag, { expire: 0 }) for immediate expiration.",
        );
      }
      return null; // correct: revalidateTag() with 2+ args, before redirect() or no redirect in scope
    }

    return null; // unrecognized function for this handler — should not be reached
  }

  /**
   * Maps @aws-sdk/client-s3 command class names to the contract postcondition that
   * covers them. This allows the scanner to fire the correct postcondition (and
   * severity) for each send() call instead of always picking the most-severe one.
   *
   * Evidence: audit 2026-04-01 — ListObjectsV2Command should be warning, not error.
   */
  private static readonly S3_COMMAND_POSTCONDITION_MAP: Record<string, string> =
    {
      // Object operations → error (data loss / downtime risk)
      GetObjectCommand: "s3-object-operation-no-try-catch",
      PutObjectCommand: "s3-object-operation-no-try-catch",
      DeleteObjectCommand: "s3-object-operation-no-try-catch",
      HeadObjectCommand: "s3-object-operation-no-try-catch",
      CopyObjectCommand: "s3-object-operation-no-try-catch",
      // Multipart operations → error (orphaned parts / data loss risk)
      CreateMultipartUploadCommand: "s3-multipart-no-try-catch",
      UploadPartCommand: "s3-multipart-no-try-catch",
      CompleteMultipartUploadCommand: "s3-multipart-no-try-catch",
      AbortMultipartUploadCommand: "s3-multipart-no-try-catch",
      // Bucket operations → error
      CreateBucketCommand: "s3-bucket-operation-no-try-catch",
      DeleteBucketCommand: "s3-bucket-operation-no-try-catch",
      HeadBucketCommand: "s3-bucket-operation-no-try-catch",
      // List operations → warning (lower severity)
      ListObjectsV2Command: "s3-list-operation-no-try-catch",
      ListObjectsCommand: "s3-list-operation-no-try-catch",
      ListBucketsCommand: "s3-list-operation-no-try-catch",
      ListMultipartUploadsCommand: "s3-list-operation-no-try-catch",
      ListPartsCommand: "s3-list-operation-no-try-catch",
    };

  /**
   * For @aws-sdk/client-s3 send() calls, inspect the first argument to determine
   * which command is being executed, then return the matching postcondition.
   *
   * Pattern: await s3Client.send(new GetObjectCommand({...}))
   *   → first arg is NewExpression with constructor name "GetObjectCommand"
   *   → look up in S3_COMMAND_POSTCONDITION_MAP
   *
   * If the command type cannot be statically determined (e.g., variable argument),
   * returns null so the caller falls back to pickMostSevere().
   */
  private pickS3SendPostcondition(
    detection: Detection,
    postconditions: Postcondition[],
  ): Postcondition | null {
    if (!ts.isCallExpression(detection.node)) return null;
    const args = detection.node.arguments;
    if (args.length === 0) return null;

    const firstArg = args[0];

    // Only handle direct `new CommandName(...)` pattern — not variables
    if (!ts.isNewExpression(firstArg)) return null;
    if (!ts.isIdentifier(firstArg.expression)) return null;

    const commandClassName = firstArg.expression.text;
    const postconditionId =
      ContractMatcher.S3_COMMAND_POSTCONDITION_MAP[commandClassName];
    if (!postconditionId) return null;

    return postconditions.find((p) => p.id === postconditionId) ?? null;
  }

  /**
   * @aws-sdk/client-ses command → postcondition map.
   * Maps SES command constructor names to their primary (most actionable) postcondition ID.
   * The generic 'send' function catches all calls; command-specific postconditions fire
   * instead when the command type can be statically determined.
   *
   * Evidence: concern-20260415-@aws-sdk-client-ses-deepen-1 through -6.
   */
  private static readonly SES_COMMAND_POSTCONDITION_MAP: Record<string, string> =
    {
      SendEmailCommand: "ses-send-email-no-try-catch",
      SendRawEmailCommand: "ses-raw-email-size-limit",
      SendTemplatedEmailCommand: "ses-template-does-not-exist",
      SendBulkTemplatedEmailCommand: "ses-bulk-template-does-not-exist",
      SendCustomVerificationEmailCommand: "ses-custom-verification-template-missing",
      CreateTemplateCommand: "ses-create-template-already-exists",
      UpdateTemplateCommand: "ses-update-template-not-found",
      TestRenderTemplateCommand: "ses-test-render-template-missing",
      CreateConfigurationSetCommand: "ses-create-config-set-already-exists",
      CreateConfigurationSetEventDestinationCommand: "ses-event-dest-config-set-not-found",
      CreateCustomVerificationEmailTemplateCommand: "ses-create-cve-template-already-exists",
      UpdateCustomVerificationEmailTemplateCommand: "ses-update-cve-template-not-found",
      // Evidence: concern-20260415-aws-sdk-client-ses-deepen-1 (SendBounceCommand)
      SendBounceCommand: "ses-send-bounce-no-try-catch",
      // Evidence: concern-20260415-aws-sdk-client-ses-deepen-2 (UpdateConfigurationSetEventDestinationCommand)
      UpdateConfigurationSetEventDestinationCommand: "ses-update-event-dest-config-set-not-found",
      // Evidence: concern-20260415-aws-sdk-client-ses-deepen-3 (PutConfigurationSetDeliveryOptionsCommand)
      PutConfigurationSetDeliveryOptionsCommand: "ses-put-delivery-options-config-set-not-found",
      // Evidence: concern-20260415-aws-sdk-client-ses-deepen-4 (DeleteConfigurationSetCommand — NOT idempotent)
      DeleteConfigurationSetCommand: "ses-delete-config-set-not-found",
      // Evidence: concern-20260416-aws-sdk-client-ses-deepen-1 (CreateReceiptRuleSetCommand)
      CreateReceiptRuleSetCommand: "ses-create-receipt-rule-set-already-exists",
      // Evidence: concern-20260416-aws-sdk-client-ses-deepen-2 (CreateReceiptRuleCommand)
      CreateReceiptRuleCommand: "ses-create-receipt-rule-ruleset-not-found",
      // Evidence: concern-20260416-aws-sdk-client-ses-deepen-3 (SetActiveReceiptRuleSetCommand)
      SetActiveReceiptRuleSetCommand: "ses-set-active-receipt-rule-set-not-found",
      // Evidence: concern-20260416-aws-sdk-client-ses-deepen-4 (CreateConfigurationSetTrackingOptionsCommand)
      CreateConfigurationSetTrackingOptionsCommand:
        "ses-create-tracking-options-config-set-not-found",
      // Evidence: concern-20260416-aws-sdk-client-ses-deepen-5 (UpdateConfigurationSetSendingEnabledCommand)
      UpdateConfigurationSetSendingEnabledCommand:
        "ses-update-config-set-sending-enabled-not-found",
      // Evidence: concern-20260416-aws-sdk-client-ses-deepen-6 (PutIdentityPolicyCommand)
      PutIdentityPolicyCommand: "ses-put-identity-policy-invalid",
      // Evidence: concern-20260416-aws-sdk-client-ses-deepen-7 (DeleteConfigurationSetEventDestinationCommand)
      DeleteConfigurationSetEventDestinationCommand: "ses-delete-event-dest-config-set-not-found",
      // Evidence: uncovered_function concerns — deepen pass added CloneReceiptRuleSetCommand,
      // CreateReceiptFilterCommand, UpdateReceiptRuleCommand postconditions but command→postcondition
      // routing was missing. Maps to the primary (most actionable) postcondition for each command.
      CloneReceiptRuleSetCommand: "ses-clone-receipt-rule-set-already-exists",
      CreateReceiptFilterCommand: "ses-create-receipt-filter-already-exists",
      UpdateReceiptRuleCommand: "ses-update-receipt-rule-invalid-action-config",
    };

  /**
   * For @aws-sdk/client-ses send() calls, inspect the first argument to determine
   * which SES command is being executed, then return the matching postcondition.
   *
   * Pattern: await sesClient.send(new SendEmailCommand({...}))
   *   → first arg is NewExpression with constructor name "SendEmailCommand"
   *   → look up in SES_COMMAND_POSTCONDITION_MAP
   *
   * If the command type cannot be statically determined (e.g., variable argument),
   * returns null so the caller falls back to pickMostSevere() / ses-send-no-try-catch.
   */
  private pickSesSendPostcondition(
    detection: Detection,
    postconditions: Postcondition[],
    contract: PackageContract,
  ): Postcondition | null {
    if (!ts.isCallExpression(detection.node)) return null;
    const args = detection.node.arguments;
    if (args.length === 0) return null;

    const firstArg = args[0];

    // Only handle direct `new CommandName(...)` pattern — not variables
    if (!ts.isNewExpression(firstArg)) return null;
    if (!ts.isIdentifier(firstArg.expression)) return null;

    const commandClassName = firstArg.expression.text;
    const postconditionId =
      ContractMatcher.SES_COMMAND_POSTCONDITION_MAP[commandClassName];
    if (!postconditionId) return null;

    // The command-specific postconditions (e.g., ses-send-email-no-try-catch for
    // SendEmailCommand) live under the command's own function entry in the contract,
    // NOT under the generic `send` function entry. We must look them up from the
    // command function entry, not from the passed `postconditions` (which is the
    // `send` function's list containing only ses-send-no-try-catch).
    const commandFuncContract = this.findFunctionContract(contract, commandClassName);
    if (commandFuncContract) {
      const found = (commandFuncContract.postconditions || []).find(
        (p) => p.id === postconditionId,
      );
      if (found) return found;
    }

    // Fallback: search passed postconditions (handles cases where the postcondition
    // was placed under the `send` function instead of a dedicated command entry).
    return postconditions.find((p) => p.id === postconditionId) ?? null;
  }

  /**
   * @aws-sdk/client-sesv2 command → postcondition map.
   * Maps SESv2 command constructor names to their primary (most actionable) postcondition ID.
   *
   * Evidence: concern-20260416-sesv2-deepen-1 (SendEmailCommand),
   *           concern-20260416-sesv2-deepen-3 (CreateEmailIdentityCommand),
   *           concern-20260416-sesv2-deepen-4 (CreateImportJobCommand).
   */
  private static readonly SESV2_COMMAND_POSTCONDITION_MAP: Record<string, string> = {
    SendEmailCommand: "sesv2-send-email-no-try-catch",
    SendBulkEmailCommand: "sesv2-bulk-email-no-try-catch",
    CreateEmailIdentityCommand: "sesv2-create-identity-no-try-catch",
    CreateImportJobCommand: "sesv2-import-job-no-try-catch",
    CreateEmailTemplate: "sesv2-create-template-no-try-catch",
  };

  /**
   * For @aws-sdk/client-sesv2 send() calls, inspect the first argument to determine
   * which SESv2 command is being executed, then return the matching postcondition.
   *
   * Pattern: await sesv2Client.send(new SendEmailCommand({...}))
   *   → first arg is NewExpression with constructor name "SendEmailCommand"
   *   → look up in SESV2_COMMAND_POSTCONDITION_MAP
   */
  private pickSesv2SendPostcondition(
    detection: Detection,
    postconditions: Postcondition[],
    contract: PackageContract,
  ): Postcondition | null {
    if (!ts.isCallExpression(detection.node)) return null;
    const args = detection.node.arguments;
    if (args.length === 0) return null;

    const firstArg = args[0];
    if (!ts.isNewExpression(firstArg)) return null;
    if (!ts.isIdentifier(firstArg.expression)) return null;

    const commandClassName = firstArg.expression.text;
    const postconditionId =
      ContractMatcher.SESV2_COMMAND_POSTCONDITION_MAP[commandClassName];
    if (!postconditionId) return null;

    const commandFuncContract = this.findFunctionContract(contract, commandClassName);
    if (commandFuncContract) {
      const found = (commandFuncContract.postconditions || []).find(
        (p) => p.id === postconditionId,
      );
      if (found) return found;
    }

    return postconditions.find((p) => p.id === postconditionId) ?? null;
  }

  /**
   * @aws-sdk/client-sqs command → postcondition map.
   * Maps SQS command constructor names to their primary (most actionable) postcondition ID.
   *
   * Evidence: concern-20260416-aws-sqs-deepen-4 (ChangeMessageVisibilityCommand),
   *           ground-truth fixture for CreateQueueCommand and PurgeQueueCommand.
   */
  private static readonly SQS_COMMAND_POSTCONDITION_MAP: Record<string, string> = {
    CreateQueueCommand: "sqs-create-queue-no-try-catch",
    PurgeQueueCommand: "sqs-purge-in-progress",
    ChangeMessageVisibilityCommand: "sqs-change-visibility-not-inflight",
  };

  /**
   * For @aws-sdk/client-sqs send() calls, inspect the first argument to determine
   * which SQS command is being executed, then return the matching postcondition.
   *
   * Pattern: await sqsClient.send(new CreateQueueCommand({...}))
   *   → first arg is NewExpression with constructor name "CreateQueueCommand"
   *   → look up in SQS_COMMAND_POSTCONDITION_MAP
   */
  private pickSqsSendPostcondition(
    detection: Detection,
    postconditions: Postcondition[],
    contract: PackageContract,
  ): Postcondition | null {
    if (!ts.isCallExpression(detection.node)) return null;
    const args = detection.node.arguments;
    if (args.length === 0) return null;

    const firstArg = args[0];
    if (!ts.isNewExpression(firstArg)) return null;
    if (!ts.isIdentifier(firstArg.expression)) return null;

    const commandClassName = firstArg.expression.text;
    const postconditionId =
      ContractMatcher.SQS_COMMAND_POSTCONDITION_MAP[commandClassName];
    if (!postconditionId) return null;

    // First: try exact function name match (e.g., if contract has a function named "CreateQueueCommand")
    const commandFuncContract = this.findFunctionContract(contract, commandClassName);
    if (commandFuncContract) {
      const found = (commandFuncContract.postconditions || []).find(
        (p) => p.id === postconditionId,
      );
      if (found) return found;
    }

    // Second: search all contract functions for "send (CommandName)" naming convention
    // The SQS contract uses names like "send (CreateQueueCommand)" rather than bare command names.
    const functions = contract.functions || [];
    for (const fn of functions) {
      if (fn.name.includes(commandClassName)) {
        const found = (fn.postconditions || []).find((p) => p.id === postconditionId);
        if (found) return found;
      }
    }

    // Third: fallback to currently-matched function's postconditions
    return postconditions.find((p) => p.id === postconditionId) ?? null;
  }

  /**
   * @aws-sdk/client-secrets-manager command → postcondition map.
   * Maps Secrets Manager command constructor names to their primary postcondition ID.
   *
   * Only commands with unique error types distinct from the generic aws-service-error
   * are listed here. Commands not listed fall through to the generic aws-service-error.
   *
   * Evidence: concern-20260611-aws-sdk-client-secrets-manager-deepen-5 through -8.
   * Evidence: concern-20260612-aws-sdk-client-secrets-manager-deepen-1 through -5 (Phase 2
   *   deepen pass — DescribeSecretCommand, ReplicateSecretToRegionsCommand,
   *   ValidateResourcePolicyCommand, TagResourceCommand, GetRandomPasswordCommand added).
   */
  private static readonly SECRETS_MANAGER_COMMAND_POSTCONDITION_MAP: Record<string, string> = {
    // LimitExceededException when staging labels exceed 20 limit across all secret versions.
    UpdateSecretVersionStageCommand: "update-secret-version-stage-no-try-catch",
    // InvalidRequestException when called on a non-rotating secret; orphaned AWSPENDING version.
    CancelRotateSecretCommand: "cancel-rotate-secret-no-try-catch",
    // PublicPolicyException (unique to this command) = silent security misconfiguration.
    PutResourcePolicyCommand: "put-resource-policy-no-try-catch",
    // InvalidRequestException when called on a non-deleted secret.
    RestoreSecretCommand: "restore-secret-no-try-catch",
    // ResourceNotFoundException / InvalidParameterException / InternalServiceError per
    // dist-types/commands/DescribeSecretCommand.d.ts @throws.
    DescribeSecretCommand: "describe-secret-no-try-catch",
    // Silent partial-failure response — response.ReplicationStatus[] contains per-region
    // Status === 'Failed' even when the Promise resolves with HTTP 200. Same family as the
    // BatchGetSecretValueCommand response.Errors[] silent-failure pattern.
    ReplicateSecretToRegionsCommand: "replicate-secret-per-region-failure-unchecked",
    // Silent security risk — response.PolicyValidationPassed boolean must be checked before
    // applying the same policy via PutResourcePolicyCommand. Failure to check = invalid policy
    // applied silently.
    ValidateResourcePolicyCommand: "validate-resource-policy-passed-flag-unchecked",
    // ResourceNotFoundException / LimitExceededException (per-secret tag quota of 50) /
    // InvalidRequestException / InvalidParameterException per dist-types/commands/TagResourceCommand.d.ts.
    // Compliance tagging pipelines fail silently and break IAM tag-condition access control.
    TagResourceCommand: "tag-resource-no-try-catch",
    // InvalidParameterException / InvalidRequestException / InternalServiceError per
    // dist-types/commands/GetRandomPasswordCommand.d.ts. Failures inside rotation Lambdas
    // can lead to a weak/empty password persisted via PutSecretValueCommand (SECURITY_RISK).
    GetRandomPasswordCommand: "get-random-password-no-try-catch",
  };

  /**
   * For @aws-sdk/client-secrets-manager send() calls, inspect the first argument to
   * determine which Secrets Manager command is being executed, then return the matching
   * postcondition.
   *
   * Pattern: await smClient.send(new UpdateSecretVersionStageCommand({...}))
   *   → first arg is NewExpression with constructor name "UpdateSecretVersionStageCommand"
   *   → look up in SECRETS_MANAGER_COMMAND_POSTCONDITION_MAP
   *
   * Evidence: concern-20260611-aws-sdk-client-secrets-manager-deepen-5 through -8.
   */
  private pickSecretsManagerSendPostcondition(
    detection: Detection,
    postconditions: Postcondition[],
    contract: PackageContract,
  ): Postcondition | null {
    if (!ts.isCallExpression(detection.node)) return null;
    const args = detection.node.arguments;
    if (args.length === 0) return null;

    const firstArg = args[0];
    if (!ts.isNewExpression(firstArg)) return null;
    if (!ts.isIdentifier(firstArg.expression)) return null;

    const commandClassName = firstArg.expression.text;
    const postconditionId =
      ContractMatcher.SECRETS_MANAGER_COMMAND_POSTCONDITION_MAP[commandClassName];
    if (!postconditionId) return null;

    // First: try exact function name match (contract has functions named after command constructors)
    const commandFuncContract = this.findFunctionContract(contract, commandClassName);
    if (commandFuncContract) {
      const found = (commandFuncContract.postconditions || []).find(
        (p) => p.id === postconditionId,
      );
      if (found) return found;
    }

    // Second: search all contract functions for matching postcondition ID
    const functions = contract.functions || [];
    for (const fn of functions) {
      if (fn.name.includes(commandClassName)) {
        const found = (fn.postconditions || []).find((p) => p.id === postconditionId);
        if (found) return found;
      }
    }

    // Third: fallback to currently-matched function's postconditions
    return postconditions.find((p) => p.id === postconditionId) ?? null;
  }

  /**
   * jsonschema validate() option-based postcondition picker.
   *
   * validate() only throws synchronously when one of these options is set in the 3rd arg:
   *   - throwFirst: true  → postcondition 'validate-throw-first'
   *   - throwAll: true    → postcondition 'validate-throw-all'
   *   - throwError: true  → postcondition 'validate-throw-error'
   *
   * Without these options, validate() returns a ValidatorResult and NEVER throws.
   * In that case, return null to suppress the violation (no error handling needed).
   *
   * Returns:
   *   - The matching Postcondition if a throw option is statically present
   *   - null if no throw option detected (caller should suppress the violation)
   *   - undefined if the call cannot be statically analyzed (fall back to most-severe)
   *
   * Evidence: concern-20260416-jsonschema-deepen-4/5; fix for FP on non-throwing validate() calls.
   */
  private pickJsonschemaValidatePostcondition(
    detection: Detection,
    postconditions: Postcondition[],
  ): Postcondition | null | undefined {
    if (!ts.isCallExpression(detection.node)) return undefined;
    const args = detection.node.arguments;

    // If no 3rd argument (options), validate() won't throw — suppress
    if (args.length < 3) return null;

    const optionsArg = args[2];

    // Only handle inline object literals: validate(data, schema, { throwFirst: true })
    // Variable options (validate(data, schema, opts)) cannot be statically analyzed.
    if (!ts.isObjectLiteralExpression(optionsArg)) return undefined;

    const optionKeys = new Set(
      optionsArg.properties
        .filter(ts.isPropertyAssignment)
        .map((p) => (ts.isIdentifier(p.name) ? p.name.text : null))
        .filter((k): k is string => k !== null),
    );

    if (optionKeys.has("throwFirst")) {
      return postconditions.find((p) => p.id === "validate-throw-first") ?? null;
    }
    if (optionKeys.has("throwAll")) {
      return postconditions.find((p) => p.id === "validate-throw-all") ?? null;
    }
    if (optionKeys.has("throwError")) {
      return postconditions.find((p) => p.id === "validate-throw-error") ?? null;
    }

    // Options object present but no throw option — validate() won't throw
    return null;
  }

  /**
   * For superagent calls, inspect the parent call chain for chained methods that indicate
   * a specific postcondition should override the default (network-error-handling).
   *
   * Pattern: await superagent.get(url).timeout({deadline: 5000})
   *   → detection fires on superagent.get(url) CallExpression
   *   → parent is PropertyAccessExpression with name 'timeout'
   *   → parent.parent is CallExpression (the .timeout({...}) call)
   *   → select 'timeout-error-identifiable'
   *
   * Pattern: await superagent.get(url).maxResponseSize(1024*1024)
   *   → parent PropertyAccessExpression has name 'maxResponseSize'
   *   → select 'max-response-size-exceeded'
   *
   * Also handles chains like: superagent.get(url).set('Auth', token).timeout({...})
   *   → walk up through multiple chained calls looking for timeout/maxResponseSize
   *
   * Returns null if no chained-method-specific postcondition found (caller uses pickMostSevere).
   */
  private pickSuperagentChainedPostcondition(
    detection: Detection,
    postconditions: Postcondition[],
  ): Postcondition | null {
    if (!ts.isCallExpression(detection.node)) return null;

    // Walk up the AST from the get()/post()/etc. call to find chained method names.
    // Each chained call looks like: CallExpr → PropAccessExpr(.timeout) → CallExpr → ...
    // We collect all chained method names above the detection node.
    const chainedMethods: string[] = [];
    let current: ts.Node = detection.node;
    while (current.parent) {
      const parent = current.parent;
      // If parent is a PropertyAccess and grandparent is a CallExpr, we're inside a chain
      if (
        ts.isPropertyAccessExpression(parent) &&
        parent.parent &&
        ts.isCallExpression(parent.parent) &&
        parent.parent.expression === parent
      ) {
        chainedMethods.push(parent.name.text);
        current = parent.parent; // move up to the outer CallExpression
      } else if (ts.isAwaitExpression(parent)) {
        break; // reached the await — stop
      } else {
        break;
      }
    }

    // .timeout() in chain → timeout-error-identifiable
    if (chainedMethods.includes("timeout")) {
      return postconditions.find((p) => p.id === "timeout-error-identifiable") ?? null;
    }

    // .maxResponseSize() in chain → max-response-size-exceeded
    if (chainedMethods.includes("maxResponseSize")) {
      return postconditions.find((p) => p.id === "max-response-size-exceeded") ?? null;
    }

    return null;
  }

  /**
   * Find a function contract by name.
   *
   * Strategy:
   * 1. Exact match: 'create' → finds function named 'create'
   * 2. Dotted-name fallback: 'login' → matches 'Client.login' (last segment equals functionName)
   *    This handles contracts like discord.js where functions are named 'Client.login', 'Message.delete'.
   */
  private findFunctionContract(
    contract: PackageContract,
    functionName: string,
    chainStr?: string,
  ): FunctionContract | null {
    const functions = contract.functions || [];

    // For property-chain detections: try chainStr-specific match first.
    // This ensures openai.embeddings.create() matches "embeddings.create" postconditions
    // instead of the generic "create" entry.
    // Matching logic: contract function name ends with chainStr (suffix match).
    // Also normalizes camelCase → snake_case for SDK vs contract name mismatches
    // (e.g., SDK uses fineTuning.jobs.create, contract uses fine_tuning.jobs.create).
    // Examples:
    //   chainStr="embeddings.create"        → matches f.name="embeddings.create" ✓
    //   chainStr="audio.speech.create"      → matches f.name="audio.speech.create" ✓
    //   chainStr="fineTuning.jobs.create"   → matches f.name="fine_tuning.jobs.create" ✓
    if (chainStr) {
      // Normalize camelCase segments to snake_case for comparison
      // e.g., "fineTuning.jobs.create" → "fine_tuning.jobs.create"
      const normalizeChain = (s: string): string =>
        s.replace(/([a-z])([A-Z])/g, "$1_$2").toLowerCase();
      const normalizedChainStr = normalizeChain(chainStr);

      // Guard: only use chainStr for function-chain matching when the chainStr actually
      // contains the functionName as a suffix (i.e., it is a real call chain like
      // "embeddings.create" for functionName="create", or "messages.create" for "create").
      // When chainStr is an instanceTypeName like "Collection" or "GuildChannel", it is
      // only used for disambiguation among dotted-name contracts later in this function —
      // not for direct function matching here. Without this guard, "Collection" would match
      // the function named "collection" in the contract, incorrectly overriding an exact
      // match on "distinct", "createIndexes", etc.
      const chainStrContainsFunctionName =
        chainStr === functionName ||
        normalizedChainStr === normalizeChain(functionName) ||
        chainStr.endsWith("." + functionName) ||
        normalizedChainStr.endsWith("." + normalizeChain(functionName));

      if (chainStrContainsFunctionName) {
        // Two-pass match. Exact match wins over suffix match so that adding a non-beta
        // postcondition (e.g., `messages.create`) to a contract that already has a
        // beta-prefixed entry (`beta.messages.create`) does not silently shadow the new
        // non-beta call. Concern: concern-20260624-scanner-deepen-4 (deepen-stream-2
        // pass 75 — anthropic-sdk parallel beta/non-beta APIs).
        // Kebab equivalent of chainStr for contracts that flatten a namespace
        // into a single kebab-cased entry name (e.g., trigger.dev's contract uses
        // `name: batch-retrieve` for the `batch.retrieve()` call, `name: envvars-upload`
        // for `envvars.upload()`, `name: idempotency-keys-create` for the camelCase
        // `idempotencyKeys.create()`, etc.). Built from the normalized form so the
        // camelCase split (snake_case) collapses correctly into kebab (`.` and `_`
        // both become `-`). Only meaningful when chainStr has multiple segments;
        // single-segment names go through the standard equality check below.
        // Without this, `batch.retrieve()` falls through to the bare-name fallback and
        // wrongly picks the `retrieve` entry (intended for `runs.retrieve()`).
        // Concern: trigger.dev namespace.method shared-name disambiguation (deepen-stream
        // pass 92; pattern #15 in bc-deepen-contract Phase 1.5).
        const kebabedChainStr = chainStr.includes(".")
          ? normalizedChainStr.replace(/[._]/g, "-")
          : null;
        const exactMatch = functions.find((f) => {
          // Build the effective full name when the contract uses the `namespace` field.
          // Contracts that use namespace+name (e.g., namespace: "messages", name: "create")
          // must be compared against chainStr using the combined "messages.create" form,
          // not just the bare function name "create".
          // Example: twilio messages.create, calls.update, calls.recordings.create, etc.
          const effectiveName = f.namespace ? `${f.namespace}.${f.name}` : f.name;

          // Exact match on the full chain string (both as-is and normalized)
          if (effectiveName === chainStr) return true;
          if (normalizeChain(effectiveName) === normalizedChainStr) return true;
          // Also match the plain f.name for non-namespaced contracts
          if (!f.namespace) {
            if (f.name === chainStr) return true;
            if (normalizeChain(f.name) === normalizedChainStr) return true;
            // Kebab variant of the chain string for namespace-as-prefix names.
            if (kebabedChainStr !== null && f.name === kebabedChainStr) return true;
          }
          return false;
        });
        if (exactMatch) {
          return exactMatch;
        }

        // Fallback: suffix match handles the leading-package-root case where the contract
        // function carries the package name as a prefix (e.g., contract has
        // `openai.embeddings.create`, detection chainStr is `embeddings.create`).
        const suffixMatch = functions.find((f) => {
          const effectiveName = f.namespace ? `${f.namespace}.${f.name}` : f.name;
          if (effectiveName.endsWith("." + chainStr)) return true;
          if (normalizeChain(effectiveName).endsWith("." + normalizedChainStr)) return true;
          if (!f.namespace) {
            if (f.name.endsWith("." + chainStr)) return true;
            if (normalizeChain(f.name).endsWith("." + normalizedChainStr)) return true;
          }
          return false;
        });
        if (suffixMatch) {
          return suffixMatch;
        }
      }
    }

    // Exact match on functionName
    const exact = functions.find((f) => f.name === functionName);
    if (exact) {
      return exact;
    }

    // Alias match: contract function has aliases array containing the detected name.
    // Example: tar contract extract has aliases: [x], create has aliases: [c].
    // When tar.x() is called, functionName='x' — resolve to the 'extract' contract.
    const aliasMatch = functions.find(
      (f) => Array.isArray(f.aliases) && f.aliases.includes(functionName),
    );
    if (aliasMatch) {
      return aliasMatch;
    }

    // Fallback: match the last segment of a dotted function name in the contract.
    // Example: functionName='login', contract has name='Client.login' → match!
    // When chainStr is provided as instanceTypeName context, prefer the contract function
    // whose class prefix matches (e.g., 'GuildChannel' in 'GuildChannel.delete').
    const dottedMatches = functions.filter((f) => {
      const parts = f.name.split(".");
      return parts.length > 1 && parts[parts.length - 1] === functionName;
    });
    if (dottedMatches.length === 1) {
      return dottedMatches[0];
    }
    if (dottedMatches.length > 1) {
      // Multiple dotted functions share the same method name (e.g., Message.delete + GuildChannel.delete).
      // Use chainStr as a hint for the class prefix if available (instanceTypeName from detection metadata).
      if (chainStr) {
        const typeMatch = dottedMatches.find((f) => {
          const parts = f.name.split(".");
          // Class prefix is everything except the last segment
          const classPrefix = parts.slice(0, -1).join(".");
          return classPrefix === chainStr;
        });
        if (typeMatch) return typeMatch;
      }
      // No disambiguation available — return the first match (maintains backwards compatibility)
      return dottedMatches[0];
    }

    return null;
  }

  /**
   * Pick the most severe postcondition (error > warning).
   */
  private pickMostSevere(postconditions: Postcondition[]): Postcondition {
    const errors = postconditions.filter((p) => p.severity === "error");
    if (errors.length > 0) {
      return errors[0];
    }
    return postconditions[0];
  }

  /**
   * Get 1-indexed line and column from a node.
   */
  private getLocation(
    node: ts.Node,
    sourceFile: ts.SourceFile,
  ): { line: number; column: number } {
    const { line, character } = sourceFile.getLineAndCharacterOfPosition(
      node.getStart(),
    );
    return {
      line: line + 1,
      column: character + 1,
    };
  }

  /**
   * Build a structured code context with 15 lines before + violation line + 5 after.
   * Returns JSON-encoded {lines: [{line, content, highlighted}]} and the 1-indexed start line.
   */
  private buildCodeContext(
    sourceFile: ts.SourceFile,
    lineIdx: number,
  ): { json: string; startLine: number } {
    const lines = sourceFile.getFullText().split("\n");
    const startIdx = Math.max(0, lineIdx - 15);
    const endIdx = Math.min(lines.length - 1, lineIdx + 5);
    const startLine = startIdx + 1; // 1-indexed for display
    const structured = lines.slice(startIdx, endIdx + 1).map((content, i) => ({
      line: startIdx + 1 + i,
      content,
      highlighted: startIdx + i === lineIdx,
    }));
    return { json: JSON.stringify({ lines: structured }), startLine };
  }

  /**
   * Checks if @clerk/nextjs middleware is properly configured.
   *
   * Looks for middleware.ts (or middleware.js) in the project root and common
   * subdirectories, then verifies it imports clerkMiddleware from @clerk/nextjs/server
   * and exports it as the default export.
   *
   * Result is cached after first call since it's constant for a given project scan.
   */
  private isClerkMiddlewareConfigured(): boolean {
    if (this.clerkMiddlewareConfigured !== null) {
      return this.clerkMiddlewareConfigured;
    }

    const searchLocations = ["", "src", "app", "apps/web", "apps/web/src"];
    const fileNames = ["middleware.ts", "middleware.js"];

    let middlewareContent: string | undefined;
    for (const loc of searchLocations) {
      for (const fileName of fileNames) {
        const fullPath = path.resolve(this.options.projectRoot, loc, fileName);
        let content: string | undefined;
        try {
          content = ts.sys.readFile(fullPath);
        } catch {
          // EACCES or other fs error — skip this location
        }
        if (content !== undefined) {
          middlewareContent = content;
          break;
        }
      }
      if (middlewareContent !== undefined) break;
    }

    if (middlewareContent === undefined) {
      this.clerkMiddlewareConfigured = false;
      return false;
    }

    // Parse the file and check for clerkMiddleware import + default export
    const tempSourceFile = ts.createSourceFile(
      "middleware.ts",
      middlewareContent,
      ts.ScriptTarget.Latest,
      true,
    );

    let hasClerkImport = false;
    let importedName: string | null = null;
    let hasDefaultExport = false;

    ts.forEachChild(tempSourceFile, (node) => {
      // Check: import { clerkMiddleware } from '@clerk/nextjs/server'
      if (ts.isImportDeclaration(node)) {
        const specifier = node.moduleSpecifier;
        if (
          ts.isStringLiteral(specifier) &&
          specifier.text.includes("@clerk/nextjs")
        ) {
          if (
            node.importClause?.namedBindings &&
            ts.isNamedImports(node.importClause.namedBindings)
          ) {
            for (const element of node.importClause.namedBindings.elements) {
              if (element.name.text === "clerkMiddleware") {
                hasClerkImport = true;
                importedName = element.name.text;
              }
            }
          }
        }
      }

      // Check: export default clerkMiddleware(...) OR export default clerkMiddleware
      if (ts.isExportAssignment(node) && node.expression) {
        if (ts.isCallExpression(node.expression)) {
          const callee = node.expression.expression;
          if (
            ts.isIdentifier(callee) &&
            importedName &&
            callee.text === importedName
          ) {
            hasDefaultExport = true;
          }
        } else if (
          ts.isIdentifier(node.expression) &&
          importedName &&
          node.expression.text === importedName
        ) {
          hasDefaultExport = true;
        }
      }
    });

    this.clerkMiddlewareConfigured = hasClerkImport && hasDefaultExport;
    return this.clerkMiddlewareConfigured;
  }

  /**
   * Checks if ClerkProvider is present anywhere in the project.
   *
   * In Next.js App Router apps, ClerkProvider typically wraps the root layout,
   * so useClerk() is always inside a provider at runtime. Static analysis cannot
   * trace the component hierarchy, so we suppress use-clerk-outside-provider
   * violations when ClerkProvider is found in any project file.
   *
   * Result is cached after first call since it's constant for a given project scan.
   */
  private projectHasClerkProvider(): boolean {
    if (this.clerkProviderPresent !== null) {
      return this.clerkProviderPresent;
    }

    // Strategy 1: Use the TypeScript program to scan source files if available.
    if (this.options.program) {
      for (const sf of this.options.program.getSourceFiles()) {
        if (sf.isDeclarationFile) continue;
        if (sf.fileName.includes("node_modules")) continue;

        // Check for ClerkProvider in JSX/TSX text
        const text = sf.getFullText();
        if (text.includes("ClerkProvider")) {
          this.clerkProviderPresent = true;
          return true;
        }
      }
      this.clerkProviderPresent = false;
      return false;
    }

    // Strategy 2: Scan common layout files using ts.sys.readFile.
    const layoutLocations = [
      "app/layout.tsx",
      "app/layout.ts",
      "src/app/layout.tsx",
      "src/app/layout.ts",
      "apps/web/app/layout.tsx",
      "apps/web/app/layout.ts",
      "apps/web/src/app/layout.tsx",
      "pages/_app.tsx",
      "pages/_app.ts",
      "src/pages/_app.tsx",
    ];

    for (const loc of layoutLocations) {
      const fullPath = path.resolve(this.options.projectRoot, loc);
      let content: string | undefined;
      try {
        content = ts.sys.readFile(fullPath);
      } catch {
        // EACCES or other fs error — skip this location
      }
      if (content && content.includes("ClerkProvider")) {
        this.clerkProviderPresent = true;
        return true;
      }
    }

    this.clerkProviderPresent = false;
    return false;
  }

  /**
   * Checks if the project wires a global error handler for React Query.
   *
   * Many React Query projects ship a global onError handler via:
   *   - new QueryCache({ onError: (error) => toast(...) })
   *   - new MutationCache({ onError: ... })
   *   - A top-level <ErrorBoundary> wrapping the app
   *   - A central error handler module (global-error-handler, app-error-handler, etc.)
   *
   * When ANY of these wirings exist, component files using useQuery / useMutation /
   * queryClient.fetchQuery typically rely on the global handler instead of repeating
   * isError / onError destructuring at every call site. The existing per-file heuristic
   * (file-text contains "isError" / "{ error" / "error }" / "onError") does not catch
   * cross-file wiring and produces false positives.
   *
   * Evidence:
   *   concern-20260515-section3-gap-1-querycache-onerror (~564 FPs estimate; rank-12
   *     openstatus 269/269 FPs, rank-06 chatbox 26/26 FPs, rank-08 sealos 299 useQuery FPs).
   *   concern-20260515-section3-gap-2-fetchquery-postconditions (1 retro instance;
   *     queryClient.fetchQuery in auth/providers.ts at rank-12 openstatus).
   *
   * Result is cached after first call since it's constant for a given project scan.
   */
  private projectHasReactQueryGlobalErrorHandler(): boolean {
    if (this.reactQueryGlobalErrorHandler !== null) {
      return this.reactQueryGlobalErrorHandler;
    }

    // Patterns that count as a global error wiring signal.
    // Each is a quick text match — we trade precision for speed since we only need ONE hit.
    const isErrorHandlerFile = (fileName: string): boolean => {
      const lower = fileName.toLowerCase();
      // ErrorBoundary.tsx, error-boundary.tsx, app-error-boundary.tsx, etc.
      if (/(^|[\\/])error[-_]?boundary\.[jt]sx?$/.test(lower)) return true;
      // global-error-handler.ts, app-error-handler.tsx, root_error_handler.ts, etc.
      if (
        /(^|[\\/])(global|app|root)[-_]error[-_]?handler\.[jt]sx?$/.test(lower)
      ) {
        return true;
      }
      return false;
    };

    const textHasGlobalSignal = (text: string): boolean => {
      // QueryCache or MutationCache with onError callback nearby.
      // Use a windowed substring scan to avoid runaway regex backtracking on large files.
      const cacheCtorIdx = text.search(/new\s+(?:Query|Mutation)Cache\s*\(/);
      if (cacheCtorIdx !== -1) {
        const window = text.slice(cacheCtorIdx, cacheCtorIdx + 400);
        if (/onError\s*:/.test(window)) return true;
      }
      // setLogger({ error: ... }) — pre-v5 global logger override
      if (text.includes("setLogger(") && /error\s*:/.test(text)) {
        // Only treat as a signal when the snippet is tight (limits FP risk).
        const setLoggerIdx = text.indexOf("setLogger(");
        const window = text.slice(setLoggerIdx, setLoggerIdx + 200);
        if (/error\s*:/.test(window)) return true;
      }
      return false;
    };

    // Strategy 1: Use the TypeScript program when available (production path).
    if (this.options.program) {
      for (const sf of this.options.program.getSourceFiles()) {
        if (sf.isDeclarationFile) continue;
        if (sf.fileName.includes("node_modules")) continue;

        if (isErrorHandlerFile(sf.fileName)) {
          this.reactQueryGlobalErrorHandler = true;
          return true;
        }

        const text = sf.getFullText();
        if (textHasGlobalSignal(text)) {
          this.reactQueryGlobalErrorHandler = true;
          return true;
        }
      }
      this.reactQueryGlobalErrorHandler = false;
      return false;
    }

    // Strategy 2: Probe common locations via ts.sys.readFile.
    const probeFiles = [
      "lib/query-client.ts",
      "lib/query-client.tsx",
      "src/lib/query-client.ts",
      "src/lib/query-client.tsx",
      "providers/QueryClientProvider.tsx",
      "src/providers/QueryClientProvider.tsx",
      "app/providers.tsx",
      "src/app/providers.tsx",
      "components/ErrorBoundary.tsx",
      "src/components/ErrorBoundary.tsx",
      "app/error.tsx",
      "src/app/error.tsx",
    ];

    for (const loc of probeFiles) {
      const fullPath = path.resolve(this.options.projectRoot, loc);
      if (isErrorHandlerFile(loc)) {
        // The presence of the file itself is a signal — check it exists.
        let content: string | undefined;
        try {
          content = ts.sys.readFile(fullPath);
        } catch {
          // not readable — skip
        }
        if (content !== undefined) {
          this.reactQueryGlobalErrorHandler = true;
          return true;
        }
      }
      let content: string | undefined;
      try {
        content = ts.sys.readFile(fullPath);
      } catch {
        // not readable — skip
      }
      if (content && textHasGlobalSignal(content)) {
        this.reactQueryGlobalErrorHandler = true;
        return true;
      }
    }

    this.reactQueryGlobalErrorHandler = false;
    return false;
  }

  /**
   * §10: detect a project-wide central error-handler middleware. When this returns true,
   * AND the callsite is in a Model-layer file (see isCallInModelLayerFile), knex
   * per-callsite error postconditions are suppressed because the architectural pattern
   * routes errors to this middleware at the app boundary.
   *
   * Signals (any one is sufficient):
   *   1. Express error-handler signature: `(err, req, res, next) =>` or
   *      `function (err, req, res, next)` anywhere in source — Express identifies error
   *      middleware by the 4-arg signature, so this text match is high-confidence.
   *   2. Express `app.use(<name>)` paired with a function whose first param is `err` or
   *      `error` — covered by signal 1 if the function is in the same file.
   *   3. NestJS `@Catch()` decorator on a class — exception filters are NestJS's
   *      analog to Express error middleware.
   *   4. Fastify `setErrorHandler(` — already detectable per §11.C corpus state.
   *   5. Koa error-handler middleware: `try { await next() } catch` shape. Koa
   *      middleware wrapping `await next()` in try-catch is the canonical Koa central
   *      error handler — the function exists for the sole purpose of catching downstream
   *      throws. Confirmed at rsschool-app server/src/routes/logging.ts:13.
   *
   * Evidence: concern-20260518-section10-knex-model-layer-fps (rank-14 lightdash's central
   *   errorHandler middleware at packages/backend/src/App.ts:736-768).
   *
   * Mirrors projectHasReactQueryGlobalErrorHandler structurally — same caching, same
   * strategy split (TS program available vs probe locations).
   */
  private projectHasCentralErrorHandlerMiddleware(): boolean {
    if (this.centralErrorHandlerMiddleware !== null) {
      return this.centralErrorHandlerMiddleware;
    }

    const textHasMiddlewareSignal = (text: string): boolean => {
      // Express error-handler signature. The 4-arg shape `(err, req, res, next)` is
      // Express's specific identifier for error middleware. Allow `error` as a synonym
      // for the first param and `_` / `_anything` for the fourth (common when next is
      // unused). Tolerate TypeScript type annotations (`err: Error, req: Request, ...`)
      // by allowing any non-comma non-paren content after each name.
      if (
        /\(\s*(?:err|error)(?:\s*:[^,)]*)?\s*,\s*(?:req|request)(?:\s*:[^,)]*)?\s*,\s*(?:res|response)(?:\s*:[^,)]*)?\s*,\s*(?:next|_\w*|_)(?:\s*:[^,)]*)?\s*\)\s*=>/.test(
          text,
        )
      ) {
        return true;
      }
      if (
        /function\s+\w*\s*\(\s*(?:err|error)(?:\s*:[^,)]*)?\s*,\s*(?:req|request)(?:\s*:[^,)]*)?\s*,\s*(?:res|response)(?:\s*:[^,)]*)?\s*,\s*(?:next|_\w*|_)(?:\s*:[^,)]*)?\s*\)/.test(
          text,
        )
      ) {
        return true;
      }
      // Sentry's Express error-handler helper. Equivalent to registering an Express
      // error middleware — see https://docs.sentry.io/platforms/javascript/guides/express/
      if (/Sentry\.setupExpressErrorHandler\s*\(/.test(text)) {
        return true;
      }
      // NestJS @Catch() decorator. The exception filter pattern.
      if (/@Catch\s*\(/.test(text)) {
        return true;
      }
      // Fastify setErrorHandler. Already a §11.C signal. Tolerate TS generics
      // (`setErrorHandler<FastifyError>(...)` per misskey's ClientServerService.ts:924).
      if (/\.setErrorHandler\b(?:\s*<[^>]+>)?\s*\(/.test(text)) {
        return true;
      }
      // Koa central error handler. The pattern is a middleware function that wraps
      // `await next()` in try-catch. This shape is essentially exclusive to Koa: Express
      // does not await `next()`, Fastify does not use `next()`, Connect uses `next()` but
      // does not await it. The bounded `{0,400}` cap avoids pathological backtracking on
      // very long try-blocks.
      if (
        /try\s*\{[\s\S]{0,400}?await\s+next\s*\(\s*\)[\s\S]{0,400}?\}\s*catch/.test(
          text,
        )
      ) {
        return true;
      }
      return false;
    };

    // Strategy 1: TypeScript program when available.
    if (this.options.program) {
      for (const sf of this.options.program.getSourceFiles()) {
        if (sf.isDeclarationFile) continue;
        if (sf.fileName.includes("node_modules")) continue;

        const text = sf.getFullText();
        if (textHasMiddlewareSignal(text)) {
          this.centralErrorHandlerMiddleware = true;
          return true;
        }
      }
      this.centralErrorHandlerMiddleware = false;
      return false;
    }

    // Strategy 2: probe common locations.
    const probeFiles = [
      "src/app.ts",
      "src/App.ts",
      "src/server.ts",
      "src/index.ts",
      "src/main.ts",
      "src/middleware/errorHandler.ts",
      "src/middleware/error-handler.ts",
      "src/middlewares/errorHandler.ts",
      "src/middlewares/error-handler.ts",
      "src/errors.ts",
      "src/error-handler.ts",
      "src/errorHandler.ts",
      "src/filters/all-exceptions.filter.ts",
      "packages/backend/src/App.ts",
      "packages/backend/src/app.ts",
      "packages/backend/src/server.ts",
    ];

    for (const loc of probeFiles) {
      const fullPath = path.resolve(this.options.projectRoot, loc);
      let content: string | undefined;
      try {
        content = ts.sys.readFile(fullPath);
      } catch {
        // not readable — skip
      }
      if (content && textHasMiddlewareSignal(content)) {
        this.centralErrorHandlerMiddleware = true;
        return true;
      }
    }

    this.centralErrorHandlerMiddleware = false;
    return false;
  }

  /**
   * §10: detect a data-layer file. A callsite is "in the data layer" when its source
   * file's basename matches a Model OR Repository naming convention, OR the file lives
   * under a `/models/` `/model/` `/repositories/` or `/repository/` directory.
   *
   * Naming conventions covered:
   *   - `*Model.ts` / `*Model.tsx` (PascalCase Model suffix, lightdash)
   *   - `*Repository.ts` / `*Repository.tsx` (PascalCase Repository suffix, NestJS)
   *   - `*.repository.ts` / `*.repository.tsx` (dotted lowercase, rsschool / NestJS CLI)
   *
   * Both Model-layer and Repository-layer files share the §10 architectural intent:
   * raw ORM errors are allowed to propagate to a central errorHandler middleware at the
   * app boundary rather than being caught per-callsite. The same gate applies to knex
   * Model files (Phase 1) and typeorm Repository files (Phase 2).
   *
   * Scope note: Prisma model-class pattern is an anticipated analog that would extend
   * this matcher further, but is not yet empirically verified.
   * See 0041-section-10-ship-decisions.md for the layered-architecture rationale.
   */
  private isCallInDataLayerFile(sourceFile: ts.SourceFile): boolean {
    const fileName = sourceFile.fileName;
    // PascalCase Model suffix (lightdash). Anchored on path separators so we match
    // `models/UserModel.ts` but NOT `models/data.ts`.
    if (/(?:^|[\\/])[A-Za-z0-9_]*Model\.tsx?$/.test(fileName)) {
      return true;
    }
    // PascalCase Repository suffix (NestJS): `UserRepository.ts`, `PostRepository.tsx`.
    if (/(?:^|[\\/])[A-Za-z0-9_]*Repository\.tsx?$/.test(fileName)) {
      return true;
    }
    // Dotted-lowercase repository naming (rsschool, NestJS CLI):
    // `user.repository.ts`, `task.repository.ts`. The `.repository.` segment is required.
    if (/(?:^|[\\/])[A-Za-z0-9_-]+\.repository\.tsx?$/.test(fileName)) {
      return true;
    }
    // Directory-segment match (case-sensitive on Unix).
    if (/(?:^|[\\/])(?:models?|repositor(?:y|ies))[\\/]/.test(fileName)) {
      return true;
    }
    return false;
  }

  /**
   * Checks if a violation node is inside an async lambda passed as the `loader:` property
   * of a `createRoute(...)`, `createFileRoute(...)`, or `createRootRoute(...)` call.
   *
   * TanStack Router's route config catches loader exceptions and routes them to the
   * `errorComponent`. So a loader callback throwing is framework-handled, not a true
   * unhandled-error site.
   *
   * Evidence: concern-20260515-section3-gap-3-router-loader-callbacks (~34 FPs at vendure).
   *           scanner-upgrades-todo.md line 46 ("Generalization to @tanstack/react-router").
   */
  private isInsideReactRouterLoaderCallback(node: ts.Node): boolean {
    const ROUTE_FACTORY_NAMES = new Set([
      "createRoute",
      "createFileRoute",
      "createRootRoute",
      "createLazyFileRoute",
      "createLazyRoute",
      "createRootRouteWithContext",
    ]);
    let cur: ts.Node | undefined = node;
    while (cur) {
      // Stop walking when we hit the source file — no route factory found.
      if (ts.isSourceFile(cur)) return false;

      // Look for: { loader: <fn> } passed as argument to a route factory call.
      if (
        ts.isPropertyAssignment(cur) &&
        ts.isIdentifier(cur.name) &&
        cur.name.text === "loader" &&
        (ts.isArrowFunction(cur.initializer) ||
          ts.isFunctionExpression(cur.initializer))
      ) {
        // Walk up to confirm the enclosing object literal is a route-factory arg.
        let parent: ts.Node | undefined = cur.parent;
        while (parent && !ts.isSourceFile(parent)) {
          if (ts.isCallExpression(parent)) {
            const callee = parent.expression;
            let calleeName = "";
            if (ts.isIdentifier(callee)) {
              calleeName = callee.text;
            } else if (ts.isPropertyAccessExpression(callee)) {
              calleeName = callee.name.text;
            }
            if (ROUTE_FACTORY_NAMES.has(calleeName)) {
              return true;
            }
            // Also support: someRoute.update({ loader: ... }) and chained patterns
            // by continuing to walk up — but stop at function boundaries below.
          }
          // Don't walk past a containing function/method declaration — loaders are
          // always inline literals in a route-factory call.
          if (
            ts.isFunctionDeclaration(parent) ||
            ts.isMethodDeclaration(parent)
          ) {
            return false;
          }
          parent = parent.parent;
        }
        return false;
      }
      cur = cur.parent;
    }
    return false;
  }

  /**
   * Built-in callback-wrapper-shell pattern list — wrapper-function / wrapper-class
   * names whose callback argument is responsible for catching errors at the wrapper
   * level, not inside the callback body.
   *
   * Evidence: concern-20260515-section8-promisecall-promisestate-wrapper-shells.
   */
  private static readonly CALLBACK_WRAPPER_NAMES: ReadonlySet<string> = new Set([
    // blinko PromiseState helpers (rank-11)
    "PromiseCall",
    "PromiseState",
    "PromisePageState",
    // common safe-async / try-catch utility names
    "safeAsync",
    "tryAwait",
    "tryCatch",
    "withErrorBoundary",
    "withTryCatch",
    "withCatch",
    // mobx async helpers
    "flow",
  ]);

  /**
   * Regex matching common safe-/try-/with-/wrap-prefixed async wrapper names.
   * Conservative — must end with one of the wrapper suffixes so we don't catch
   * arbitrary identifiers like `safeUser` or `withRouter`.
   */
  private static readonly CALLBACK_WRAPPER_NAME_REGEX =
    /^(safe|try|with|wrap)[A-Z][a-zA-Z0-9]*(Async|Await|ErrorBoundary|Call|Catch)$/;

  /**
   * Property names commonly used to pass a callback into a wrapper class via an
   * object literal: e.g., `new PromiseState({ function: async () => ... })`.
   */
  private static readonly CALLBACK_WRAPPER_PROPERTY_NAMES: ReadonlySet<string> =
    new Set(["function", "init", "callback", "fn"]);

  /**
   * Collects the set of identifier names imported at the top of the file
   * (default, named, namespace, side-effect-imported). Used to gate the
   * callback-wrapper suppression on the imported-at-file-level constraint
   * so a locally-declared function named `PromiseCall` does NOT match.
   */
  private collectFileImportedIdentifiers(
    sourceFile: ts.SourceFile,
  ): Set<string> {
    const names = new Set<string>();
    for (const stmt of sourceFile.statements) {
      if (!ts.isImportDeclaration(stmt) || !stmt.importClause) continue;
      const clause = stmt.importClause;
      // Default import: `import Foo from 'x'`
      if (clause.name) {
        names.add(clause.name.text);
      }
      if (clause.namedBindings) {
        if (ts.isNamespaceImport(clause.namedBindings)) {
          // `import * as Foo from 'x'`
          names.add(clause.namedBindings.name.text);
        } else if (ts.isNamedImports(clause.namedBindings)) {
          // `import { Foo, Bar as Baz } from 'x'`
          for (const el of clause.namedBindings.elements) {
            names.add(el.name.text);
          }
        }
      }
    }
    return names;
  }

  /**
   * Returns the extra `callback_wrappers: [<name>]` list configured in the
   * project's `.nark/suppress.yaml` (cached after first call).
   */
  private getExtraCallbackWrappers(): string[] {
    if (this.extraCallbackWrappers !== null) return this.extraCallbackWrappers;
    try {
      const cfg = loadWrapperConfigSync(this.options.projectRoot);
      this.extraCallbackWrappers = cfg.callback_wrappers ?? [];
    } catch {
      this.extraCallbackWrappers = [];
    }
    return this.extraCallbackWrappers;
  }

  /**
   * Returns true when `name` is recognised as a callback-wrapper shell name —
   * matched against the built-in set, the safe/try/with/wrap-prefixed regex,
   * or the project-level `.nark/suppress.yaml` `callback_wrappers` extension.
   */
  private isWrapperShellName(name: string): boolean {
    if (ContractMatcher.CALLBACK_WRAPPER_NAMES.has(name)) return true;
    if (ContractMatcher.CALLBACK_WRAPPER_NAME_REGEX.test(name)) return true;
    for (const extra of this.getExtraCallbackWrappers()) {
      if (extra === name) return true;
    }
    return false;
  }

  /**
   * Extracts the wrapper-shell name from a Call/NewExpression callee. Handles
   * three callee shapes:
   *   - Identifier:                 PromiseCall(...)
   *   - PropertyAccessExpression:   Result.try(...)    → returns "Result.try" first,
   *                                                       and falls back to "try"
   *   - NewExpression Identifier:   new PromiseState(...)
   *
   * For PropertyAccess, both the dotted form (`Result.tryAsync`) and the bare
   * method name (`tryAsync`) are checked so mobx `flow.bind` etc. match too.
   */
  private wrapperShellNamesFromCallee(callee: ts.Expression): string[] {
    if (ts.isIdentifier(callee)) {
      return [callee.text];
    }
    if (ts.isPropertyAccessExpression(callee)) {
      const root = callee.expression;
      const prop = callee.name.text;
      const rootName = ts.isIdentifier(root) ? root.text : "";
      if (rootName) {
        return [`${rootName}.${prop}`, prop, rootName];
      }
      return [prop];
    }
    return [];
  }

  /**
   * Checks if a violation node is inside an async lambda that is supplied as
   * the callback of a known callback-wrapper-shell — i.e., the try-catch lives
   * one stack frame up in the wrapper class/function.
   *
   * Two recognized shapes:
   *   (a) Arrow/function expression passed as a direct argument to a
   *       CallExpression / NewExpression whose callee is a file-level imported
   *       Identifier matching the wrapper-name pattern list.
   *   (b) Arrow/function expression that is the value of a `function:` /
   *       `init:` / `callback:` / `fn:` property of an object literal that is
   *       itself an argument to such a Call/NewExpression.
   *
   * Suppression is gated on the imported-at-file-level constraint: a locally-
   * declared function named `PromiseCall` that is NOT imported (or extended via
   * .nark/suppress.yaml) does NOT match — prevents name-collision over-suppression.
   *
   * Evidence: concern-20260515-section8-promisecall-promisestate-wrapper-shells (~416
   *           FPs across blinko, rybbit, gpt4free-ts).
   *           concern-20260515-section8-trpc-query-wrapper-shells (~100 FPs).
   *           Structurally analogous to isInsideReactRouterLoaderCallback().
   */
  private isInsideCallbackWrapperShell(
    node: ts.Node,
    sourceFile: ts.SourceFile,
  ): boolean {
    const importedNames = this.collectFileImportedIdentifiers(sourceFile);
    // Project-level extension via .nark/suppress.yaml — the user explicitly opted
    // these names in regardless of whether they appear as imports.
    const extra = this.getExtraCallbackWrappers();

    // Helper: given a Call/NewExpression's callee, check the wrapper-shell name
    // list and the import-gating constraint. Returns true if this is a known
    // wrapper-shell call we should suppress through.
    const matchesWrapperShellCallee = (callee: ts.Expression): boolean => {
      const candidates = this.wrapperShellNamesFromCallee(callee);
      for (const candidate of candidates) {
        if (this.isWrapperShellName(candidate)) {
          if (ts.isIdentifier(callee)) {
            if (
              importedNames.has(callee.text) ||
              extra.includes(callee.text)
            ) {
              return true;
            }
            // Locally-declared shadow — does not match.
          } else {
            // PropertyAccess (e.g., Result.try) — match by dotted name.
            return true;
          }
        }
      }
      return false;
    };

    // Shape (c): the violation node is itself a direct argument (or transitive
    // argument inside a property access on the result) of a wrapper-shell call —
    // e.g., `PromiseCall(trpc.x.query(...))`. No intermediate lambda. The
    // wrapper's body wraps the await/then in try-catch.
    {
      let p: ts.Node | undefined = node.parent;
      while (p && !ts.isSourceFile(p)) {
        if (ts.isCallExpression(p) || ts.isNewExpression(p)) {
          if (matchesWrapperShellCallee(p.expression)) {
            return true;
          }
          // Don't escape past unrelated outer calls.
          break;
        }
        // Stop at function/lambda boundaries — Shape (a)/(b) below handle those.
        if (
          ts.isArrowFunction(p) ||
          ts.isFunctionExpression(p) ||
          ts.isFunctionDeclaration(p) ||
          ts.isMethodDeclaration(p) ||
          ts.isConstructorDeclaration(p)
        ) {
          break;
        }
        p = p.parent;
      }
    }

    let cur: ts.Node | undefined = node;
    while (cur) {
      if (ts.isSourceFile(cur)) return false;

      // Walk up until we hit an enclosing arrow/function expression — that's
      // the callback whose surrounding wrapper we want to inspect.
      if (ts.isArrowFunction(cur) || ts.isFunctionExpression(cur)) {
        const callback = cur;

        // Shape (a): callback is a direct argument to a Call/NewExpression.
        if (
          callback.parent &&
          (ts.isCallExpression(callback.parent) ||
            ts.isNewExpression(callback.parent))
        ) {
          if (matchesWrapperShellCallee(callback.parent.expression)) {
            return true;
          }
        }

        // Shape (b): callback is the value of a `function:` / `init:` /
        // `callback:` / `fn:` property in an object literal that is itself an
        // argument to a Call/NewExpression.
        if (
          callback.parent &&
          ts.isPropertyAssignment(callback.parent) &&
          ts.isIdentifier(callback.parent.name) &&
          ContractMatcher.CALLBACK_WRAPPER_PROPERTY_NAMES.has(
            callback.parent.name.text,
          ) &&
          callback.parent.parent &&
          ts.isObjectLiteralExpression(callback.parent.parent) &&
          callback.parent.parent.parent &&
          (ts.isCallExpression(callback.parent.parent.parent) ||
            ts.isNewExpression(callback.parent.parent.parent))
        ) {
          if (
            matchesWrapperShellCallee(
              callback.parent.parent.parent.expression,
            )
          ) {
            return true;
          }
        }

        // Found the enclosing callback but it doesn't match a wrapper shell —
        // stop here so we don't escape to an outer function.
        return false;
      }

      // Don't escape across function-declaration / method-declaration boundaries.
      if (
        ts.isFunctionDeclaration(cur) ||
        ts.isMethodDeclaration(cur) ||
        ts.isConstructorDeclaration(cur)
      ) {
        return false;
      }

      cur = cur.parent;
    }
    return false;
  }

  /**
   * Returns true when the detection node is inside an arrow/function-expression
   * passed as the FIRST argument to a `tryCatch(...)` or `*.tryCatch(...)` call
   * that is imported at the file level — covering fp-ts `TE.tryCatch` and
   * `E.tryCatch` patterns.
   *
   * `TE.tryCatch(async () => risky(), onError)` captures the rejection in the
   * Left of the TaskEither — errors ARE handled even though there is no
   * surrounding try-catch at the call site.
   *
   * This is a narrower variant of `isInsideCallbackWrapperShell` scoped to
   * the `tryCatch` method name specifically. It avoids the broad
   * CALLBACK_WRAPPER_NAMES list (which includes `"flow"`, `"safeAsync"`, etc.)
   * that would over-suppress if applied globally. The tryCatch name is precise:
   * both fp-ts and a handful of other functional-error libraries use exactly
   * this name for "run the callback, put errors in the Left / error channel."
   *
   * Evidence: concern-20260712-lead-13-fp-ts-tryCatch-wrapping — hoppscotch
   * uses TE.tryCatch(async () => axios.post(...), onError) throughout its
   * codebase. The axios call has no try-catch but IS handled.
   */
  private isInsideFunctionalTryCatch(
    node: ts.Node,
    sourceFile: ts.SourceFile,
  ): boolean {
    const importedNames = this.collectFileImportedIdentifiers(sourceFile);

    // Helper: given a CallExpression callee, return true if it is a `tryCatch`
    // method that is either:
    //   (a) a bare `tryCatch` imported at file level, OR
    //   (b) a property access `NS.tryCatch` where `NS` is imported at file level.
    const isTryCatchCallee = (callee: ts.Expression): boolean => {
      if (ts.isIdentifier(callee)) {
        return callee.text === "tryCatch" && importedNames.has(callee.text);
      }
      if (ts.isPropertyAccessExpression(callee)) {
        if (callee.name.text !== "tryCatch") return false;
        // Namespace import: `import * as TE from 'fp-ts/TaskEither'`
        // callee.expression is the TE identifier.
        if (ts.isIdentifier(callee.expression)) {
          return importedNames.has(callee.expression.text);
        }
        return true; // chained access — allow conservatively
      }
      return false;
    };

    // Walk up from node, looking for an enclosing arrow/function-expression
    // that is the FIRST argument to a tryCatch(...) call.
    let cur: ts.Node | undefined = node;
    while (cur) {
      if (ts.isSourceFile(cur)) return false;

      if (ts.isArrowFunction(cur) || ts.isFunctionExpression(cur)) {
        const callback = cur;
        // Shape: callback is a direct argument to a Call/NewExpression.
        if (
          callback.parent &&
          ts.isCallExpression(callback.parent) &&
          isTryCatchCallee(callback.parent.expression) &&
          callback.parent.arguments[0] === callback
        ) {
          return true;
        }
        // Stop — found the enclosing callback but it's not inside tryCatch.
        return false;
      }

      // Don't escape across function-declaration / method-declaration boundaries.
      if (
        ts.isFunctionDeclaration(cur) ||
        ts.isMethodDeclaration(cur) ||
        ts.isConstructorDeclaration(cur)
      ) {
        return false;
      }

      cur = cur.parent;
    }
    return false;
  }

  /**
   * Checks if a catch clause body contains an `instanceof` binary expression
   * matching the given pattern string.
   *
   * Used to satisfy postconditions that are resolved by explicit instanceof checks,
   * e.g., `catch (e) { if (e instanceof Stripe.errors.StripeRateLimitError) ... }`.
   */
  private catchHasInstanceofPattern(
    catchClause: ts.CatchClause,
    pattern: string,
  ): boolean {
    let found = false;

    const visit = (node: ts.Node): void => {
      if (found) return;

      if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.InstanceOfKeyword
      ) {
        const rhsText = node.right.getText();
        if (rhsText === pattern) {
          found = true;
          return;
        }
      }

      ts.forEachChild(node, visit);
    };

    visit(catchClause.block);
    return found;
  }

  /**
   * Detect assertion-style zod parse() usage where crashing on invalid data is intentional.
   * Patterns: config/factory callbacks, concise arrow validators, top-level module assertions.
   * Evidence: civitai audit 2026-05-05 — 8 FPs in orchestrator inputFn callbacks.
   */
  private isZodAssertionStyleParse(node: ts.Node): boolean {
    let current: ts.Node | undefined = node;

    while (current) {
      // Stop at async functions — async parse() likely processes external/user data
      if (
        (ts.isArrowFunction(current) || ts.isFunctionExpression(current)) &&
        current.modifiers?.some(
          (m) => m.kind === ts.SyntaxKind.AsyncKeyword,
        )
      ) {
        return false;
      }

      // Sync arrow/function as a property value in an object literal = config callback
      if (
        (ts.isArrowFunction(current) || ts.isFunctionExpression(current)) &&
        current.parent &&
        ts.isPropertyAssignment(current.parent) &&
        current.parent.parent &&
        ts.isObjectLiteralExpression(current.parent.parent)
      ) {
        return true; // e.g., { inputFn: (data) => schema.parse(data) }
      }

      // Concise sync arrow (expression body, not block body)
      if (
        ts.isArrowFunction(current) &&
        !ts.isBlock(current.body)
      ) {
        return true; // e.g., (x) => schema.parse(x)
      }

      // Short sync function (1-2 statements)
      if (
        (ts.isArrowFunction(current) || ts.isFunctionExpression(current)) &&
        ts.isBlock(current.body) &&
        current.body.statements.length <= 2
      ) {
        return true; // Short validation helper
      }

      // Top-level variable declaration — startup assertion
      if (
        ts.isVariableDeclaration(current) &&
        current.parent &&
        ts.isVariableDeclarationList(current.parent) &&
        current.parent.parent &&
        ts.isVariableStatement(current.parent.parent) &&
        current.parent.parent.parent &&
        ts.isSourceFile(current.parent.parent.parent)
      ) {
        return true; // const config = schema.parse(rawConfig)
      }

      // Stop at function/class boundaries
      if (
        ts.isFunctionDeclaration(current) ||
        ts.isMethodDeclaration(current) ||
        ts.isClassDeclaration(current)
      ) {
        break;
      }

      current = current.parent;
    }

    return false;
  }

  /**
   * Suppression detector for callback-style contracted methods wrapped in a
   * `new Promise((resolve, reject) => ...)` executor whose callback propagates
   * `err` via `reject(err)`.
   *
   * Canonical shape (snowflake-sdk, ssh2, mongodb native cb-API, generic node-
   * style cb wrappers):
   *
   *   await new Promise((resolve, reject) => {
   *     connection.connect((err, conn) => {
   *       if (err) { reject(err); return; }
   *       resolve(conn);
   *     });
   *   });
   *
   * Named-property variant (snowflake `complete:`, mongoose `callback:`):
   *
   *   await new Promise((resolve, reject) => {
   *     connection.execute({
   *       sqlText: '...',
   *       complete: (err, stmt, rows) => {
   *         if (err) { reject(err); return; }
   *         resolve(rows);
   *       },
   *     });
   *   });
   *
   * When this returns true the inner callback's apparent missing try/catch is a
   * false positive — the rejection propagates to the outer `await`, which IS
   * the user's responsibility and is the right anchor for a try/catch.
   *
   * Evidence: 2026-06-23 audit-stream wave 1+2 candidate #4
   * (callback-err-guard-in-promise-wrapper-not-detected), 3+ occurrences across
   * matt1398/claude-devtools (ssh2.exec) and growthbook/back-end
   * (snowflake-sdk.connect + .execute).
   */
  private isCallbackErrGuardedInPromiseExecutor(
    callNode: ts.CallExpression,
  ): boolean {
    const executor = this.findEnclosingPromiseExecutor(callNode);
    if (!executor) return false;
    const callback = this.extractCallbackArg(callNode);
    if (!callback) return false;
    if (callback.parameters.length === 0) return false;
    const errParam = callback.parameters[0];
    if (!ts.isIdentifier(errParam.name)) return false;
    const errName = errParam.name.text;
    // Err-style param name (err, error, e — case-insensitive).
    if (!/^(err|error|e)$/i.test(errName)) return false;
    return this.callbackBodyEarlyRejectsOnErr(
      callback.body,
      errName,
      executor.rejectName,
    );
  }

  /**
   * Walks up from `node` looking for a `new Promise((resolve, reject) => ...)`
   * executor. Returns the executor's reject-param name, or null if the call
   * site isn't inside such an executor. Stops at any non-executor function
   * boundary so we never cross unrelated nested function scopes.
   */
  private findEnclosingPromiseExecutor(
    node: ts.Node,
  ): { rejectName: string } | null {
    let cur: ts.Node | undefined = node.parent;
    while (cur) {
      if (ts.isArrowFunction(cur) || ts.isFunctionExpression(cur)) {
        const parent = cur.parent;
        const isExecutor =
          parent &&
          ts.isNewExpression(parent) &&
          ts.isIdentifier(parent.expression) &&
          parent.expression.text === "Promise" &&
          parent.arguments &&
          parent.arguments[0] === cur;
        if (isExecutor) {
          const params = cur.parameters;
          if (params.length < 2) return null;
          const rejectParam = params[1];
          if (!ts.isIdentifier(rejectParam.name)) return null;
          return { rejectName: rejectParam.name.text };
        }
        // Non-executor function — don't escape its scope.
        return null;
      }
      if (
        ts.isFunctionDeclaration(cur) ||
        ts.isMethodDeclaration(cur) ||
        ts.isConstructorDeclaration(cur) ||
        ts.isGetAccessorDeclaration(cur) ||
        ts.isSetAccessorDeclaration(cur)
      ) {
        return null;
      }
      cur = cur.parent;
    }
    return null;
  }

  /**
   * Returns the callback ArrowFunction/FunctionExpression argument of a call
   * site, supporting both positional (last arg is a function) and named-
   * property variants (last arg is an object literal with a `callback:` /
   * `complete:` / `cb:` / `done:` / `fn:` property whose value is a function).
   */
  private extractCallbackArg(
    callNode: ts.CallExpression,
  ): ts.ArrowFunction | ts.FunctionExpression | null {
    const args = callNode.arguments;
    if (args.length === 0) return null;

    const last = args[args.length - 1];
    if (ts.isArrowFunction(last) || ts.isFunctionExpression(last)) {
      return last;
    }
    if (ts.isObjectLiteralExpression(last)) {
      for (const prop of last.properties) {
        if (!ts.isPropertyAssignment(prop)) continue;
        if (!ts.isIdentifier(prop.name)) continue;
        if (
          !ContractMatcher.PROMISE_WRAPPER_CALLBACK_PROPS.has(prop.name.text)
        ) {
          continue;
        }
        const value = prop.initializer;
        if (ts.isArrowFunction(value) || ts.isFunctionExpression(value)) {
          return value;
        }
      }
    }
    return null;
  }

  /**
   * Object-literal property names that conventionally carry a node-style
   * callback in callback-API packages. Used by the Promise(executor) callback-
   * err-guard suppression.
   */
  private static readonly PROMISE_WRAPPER_CALLBACK_PROPS: ReadonlySet<string> =
    new Set(["callback", "complete", "cb", "done", "fn"]);

  /**
   * Checks the callback body for the canonical early-reject-on-err guard
   * pattern.  Recognises:
   *
   *   if (err) { reject(err); ... [return] }
   *   if (err) reject(err);
   *   if (err) return reject(err);
   *   (err, val) => err ? reject(err) : resolve(val)
   *
   * Conservative: requires literal `err` identifier passed to the reject call
   * (not `reject(new Error(...))` or `reject(err.message)`) and an err-truth
   * check (`err`, `!!err`, `err != null`, `err !== null`).
   */
  private callbackBodyEarlyRejectsOnErr(
    body: ts.ConciseBody,
    errName: string,
    rejectName: string,
  ): boolean {
    if (!ts.isBlock(body)) {
      // Expression body — only ternary `err ? reject(err) : resolve(val)` counts.
      if (!ts.isConditionalExpression(body)) return false;
      if (!this.isErrTruthCheck(body.condition, errName)) return false;
      return this.isRejectErrCall(body.whenTrue, errName, rejectName);
    }
    const stmts = body.statements;
    if (stmts.length === 0) return false;
    const first = stmts[0];
    if (!ts.isIfStatement(first)) return false;
    if (!this.isErrTruthCheck(first.expression, errName)) return false;
    return this.statementCallsReject(
      first.thenStatement,
      errName,
      rejectName,
    );
  }

  private isErrTruthCheck(expr: ts.Expression, errName: string): boolean {
    // err
    if (ts.isIdentifier(expr) && expr.text === errName) return true;
    // !!err
    if (
      ts.isPrefixUnaryExpression(expr) &&
      expr.operator === ts.SyntaxKind.ExclamationToken &&
      ts.isPrefixUnaryExpression(expr.operand) &&
      expr.operand.operator === ts.SyntaxKind.ExclamationToken &&
      ts.isIdentifier(expr.operand.operand) &&
      expr.operand.operand.text === errName
    ) {
      return true;
    }
    // err != null / err !== null / err != undefined / err !== undefined
    if (
      ts.isBinaryExpression(expr) &&
      ts.isIdentifier(expr.left) &&
      expr.left.text === errName &&
      (expr.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsToken ||
        expr.operatorToken.kind ===
          ts.SyntaxKind.ExclamationEqualsEqualsToken) &&
      (expr.right.kind === ts.SyntaxKind.NullKeyword ||
        (ts.isIdentifier(expr.right) && expr.right.text === "undefined"))
    ) {
      return true;
    }
    return false;
  }

  private statementCallsReject(
    stmt: ts.Statement,
    errName: string,
    rejectName: string,
  ): boolean {
    if (ts.isBlock(stmt)) {
      for (const s of stmt.statements) {
        if (this.statementCallsReject(s, errName, rejectName)) return true;
      }
      return false;
    }
    if (ts.isExpressionStatement(stmt)) {
      return this.isRejectErrCall(stmt.expression, errName, rejectName);
    }
    if (ts.isReturnStatement(stmt) && stmt.expression) {
      return this.isRejectErrCall(stmt.expression, errName, rejectName);
    }
    return false;
  }

  private isRejectErrCall(
    expr: ts.Expression,
    errName: string,
    rejectName: string,
  ): boolean {
    if (!ts.isCallExpression(expr)) return false;
    if (!ts.isIdentifier(expr.expression)) return false;
    if (expr.expression.text !== rejectName) return false;
    if (expr.arguments.length === 0) return false;
    const arg = expr.arguments[0];
    return ts.isIdentifier(arg) && arg.text === errName;
  }

  /**
   * Returns true when `expr` is an expression that is guaranteed to produce a JavaScript
   * number (including NaN, which is typeof 'number'). Used to suppress luxon fromMillis /
   * fromSeconds violations when the argument type already satisfies the number check.
   *
   * The postcondition frommillis-non-number-throws fires only when typeof arg !== 'number'.
   * Since NaN is typeof 'number', any expression that always returns a JS number (including NaN)
   * cannot trigger the InvalidArgumentError throw.
   *
   * SCOPE: only explicit numeric-coercion API calls and numeric literals. Binary arithmetic
   * expressions like `value / 1000` are intentionally EXCLUDED because the upstream variable
   * may be non-numeric, and the labeling data shows majority TP verdict for those patterns.
   *
   * Covered patterns:
   *   - Call to Number(...), parseInt(...), parseFloat(...)
   *   - Call to Math.max(x, y), Math.min(x, y), Math.floor(x), Math.ceil(x), Math.round(x),
   *     Math.abs(x), Math.trunc(x) — all return typeof number
   *   - A numeric literal: DateTime.fromMillis(0)
   *   - An identifier that was recently assigned from one of the above (10-line lookback)
   *     Handles: dt = Math.max(dt, 0); Duration.fromMillis(dt)
   *
   * Evidence: concern-20260712-lead-14 (key-14); backstage (Math.max clamped, 2 violations),
   * n8n-nodes-base (parseInt / Number coercions). Labelers A+C at 0.85-0.9 marked these as FP.
   * See the inline comment above the call site in matchDetections() for full rationale.
   */
  private isNumericGuaranteedExpression(
    expr: ts.Expression,
    sourceFile: ts.SourceFile,
    callNode: ts.Node,
  ): boolean {
    // Direct numeric literal: DateTime.fromMillis(1000)
    if (ts.isNumericLiteral(expr)) {
      return true;
    }

    // Call to Number(...), parseInt(...), parseFloat(...)
    if (ts.isCallExpression(expr) && ts.isIdentifier(expr.expression)) {
      const globalNumericFns = new Set(["Number", "parseInt", "parseFloat"]);
      if (globalNumericFns.has(expr.expression.text)) {
        return true;
      }
    }

    // Call to Math.max(...), Math.min(...), Math.floor(...), Math.ceil(...), Math.round(...),
    // Math.abs(...), Math.trunc(...) — all return typeof number (possibly NaN, but still a number).
    // Note: Math.random(), Math.PI, etc. are NOT call expressions, so they don't match here.
    if (
      ts.isCallExpression(expr) &&
      ts.isPropertyAccessExpression(expr.expression) &&
      ts.isIdentifier(expr.expression.expression) &&
      expr.expression.expression.text === "Math"
    ) {
      const mathNumericFns = new Set([
        "max", "min", "floor", "ceil", "round", "abs", "trunc",
      ]);
      if (mathNumericFns.has(expr.expression.name.text)) {
        return true;
      }
    }

    // Identifier that was recently assigned from a numeric-coercion call.
    // Handles the backstage pattern: dt = Math.max(dt, 0); ...; Duration.fromMillis(dt)
    // Look within 10 source lines preceding the call site for an assignment of the form:
    //   <varName> = Math.max(  /  <varName> = parseInt(  / etc.
    if (ts.isIdentifier(expr)) {
      const varName = expr.text;
      const { line: callLine } = sourceFile.getLineAndCharacterOfPosition(callNode.getStart());
      const fileLines = sourceFile.getFullText().split("\n");
      const lookbackStart = Math.max(0, callLine - 10);
      const numericFnPattern = /(?:Math\.(?:max|min|floor|ceil|round|abs|trunc)\s*\(|parseInt\s*\(|parseFloat\s*\(|Number\s*\()/;
      const assignPattern = new RegExp(`\\b${varName}\\s*=\\s*`);
      for (let i = callLine - 1; i >= lookbackStart; i--) {
        const lineText = fileLines[i] ?? "";
        if (assignPattern.test(lineText) && numericFnPattern.test(lineText)) {
          return true;
        }
      }
    }

    return false;
  }
}
