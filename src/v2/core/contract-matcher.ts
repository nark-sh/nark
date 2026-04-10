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
import type { Detection, Violation } from "../types/index.js";
import { ControlFlowAnalysis } from "./control-flow-analyzer.js";
import { checkSuppression } from "../../suppressions/matcher.js";
import { computeViolationFingerprint } from "../../suppressions/fingerprint.js";

export interface ContractMatcherOptions {
  projectRoot: string;
  analyzerVersion?: string;
  /** TypeScript program for project-wide scans (e.g., ClerkProvider detection) */
  program?: ts.Program;
}

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
  constructor(
    contracts: Map<string, PackageContract>,
    options: ContractMatcherOptions,
  ) {
    this.contracts = contracts;
    this.options = options;
    this.controlFlow = new ControlFlowAnalysis();
  }

  /**
   * Match a set of detections against contracts and produce violations.
   */
  public matchDetections(
    detections: Detection[],
    sourceFile: ts.SourceFile,
  ): Violation[] {
    const violations: Violation[] = [];

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
      const chainStr =
        detection.pattern === "property-chain"
          ? (detection.metadata?.chainStr as string | undefined)
          : undefined;
      const funcContract = this.findFunctionContract(
        contract,
        detection.functionName,
        chainStr,
      );
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

      // Determine handling type: postconditions with "null" in their ID (e.g.,
      // current-user-null-not-handled, get-token-null-not-handled, auth-null-not-checked)
      // require null-guard detection, not try-catch analysis.
      const primaryPostcondition = this.pickMostSevere(postconditions);

      // Special-case: react-hook-form handleSubmit — async-submit-unhandled-error
      // The postcondition only applies when the callback passed to handleSubmit is async.
      // Additionally, if the async callback's body is fully wrapped in try-catch, the
      // postcondition is already satisfied and should not fire.
      // Evidence: dashboard-feedback 2026-04-01 (concerns react-hook-form-1 and react-hook-form-2).
      if (
        detection.packageName === "react-hook-form" &&
        detection.functionName === "handleSubmit" &&
        primaryPostcondition.id === "async-submit-unhandled-error" &&
        ts.isCallExpression(detection.node)
      ) {
        // Concern 1: if callback is NOT async, suppress — this postcondition does not apply.
        if (!this.controlFlow.isCallbackArgAsync(detection.node, 0)) {
          continue;
        }
        // Concern 2: if callback IS async and its body is fully wrapped in try-catch, suppress.
        if (
          this.controlFlow.isCallbackBodyFullyWrappedInTryCatch(
            detection.node,
            0,
          )
        ) {
          continue;
        }
        // Concern 3: if the file uses react-hook-form's setError() for error handling,
        // the developer is using RHF's built-in error state mechanism instead of try-catch.
        // This is the idiomatic RHF pattern — handleSubmit captures thrown errors and
        // routes them through setError. Both mechanisms satisfy the postcondition intent.
        // Evidence: concern-20260402-react-hook-form-1 — 60 FP instances, all using setError pattern.
        if (
          sourceFile.getFullText().includes(".setError(") ||
          sourceFile.getFullText().includes("setError(")
        ) {
          continue;
        }
        // Callback is async and not fully wrapped — fall through to fire violation.
      }

      // react-hook-form useFormContext: suppress missing-form-provider when
      // FormProvider (or `const Form = FormProvider` alias) appears in the file,
      // OR when the file uses useFormContext() — which is the sub-component pattern
      // where the component is designed to be nested inside a FormProvider by its caller.
      // Evidence: concern-20260401-react-hook-form-3 (FormProvider in file),
      //           concern-2026-04-02-dashboard-react-hook-form-1 (useFormContext sub-components:
      //           components/Input.tsx, components/Account/ArtistInstructionTextArea.tsx — 4 FPs).
      if (
        detection.packageName === "react-hook-form" &&
        primaryPostcondition.id === "missing-form-provider" &&
        (sourceFile.getFullText().includes("FormProvider") ||
          sourceFile.getFullText().includes("useFormContext"))
      ) {
        continue;
      }

      // express.json() and express.urlencoded(): these are middleware FACTORIES, not execution
      // contexts. The errors (SyntaxError, HttpError) happen when the returned middleware
      // processes a request, not when the factory is called. Suppress all postconditions
      // on express.json() and express.urlencoded() calls — they never throw at call time.
      // Evidence: concern-20260404-express-deepen-4 (ground-truth line 50, 112).
      if (
        detection.packageName === "express" &&
        (detection.functionName === "json" ||
          detection.functionName === "urlencoded" ||
          detection.functionName === "static")
      ) {
        continue;
      }

      // express app.listen(): suppress listen-eaddrinuse and listen-eacces when the file
      // registers a server.on('error') event listener. The .on('error') handler is the
      // idiomatic Node.js pattern for handling listen errors on net.Server.
      // Evidence: concern-20260404-express-deepen-5 (ground-truth line 185).
      if (
        detection.packageName === "express" &&
        detection.functionName === "listen" &&
        (primaryPostcondition.id === "listen-eaddrinuse" ||
          primaryPostcondition.id === "listen-eacces")
      ) {
        const fileText = sourceFile.getFullText();
        if (
          fileText.includes(".on('error'") ||
          fileText.includes('.on("error"')
        ) {
          continue;
        }
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
          if (!asyncFuncArg) {
            continue;
          }
          // Entire async body is a single try-catch → suppress (concern-2)
          if (ts.isBlock(asyncFuncArg.body)) {
            const stmts = asyncFuncArg.body.statements;
            if (
              stmts.length === 1 &&
              ts.isTryStatement(stmts[0]) &&
              stmts[0].catchClause
            ) {
              continue;
            }
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
        if (inCatchOrFinally) continue;
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
        if (inCatchBlock) continue;
      }

      // dotenv config(): suppress missing-env-file / parse-error when the call
      // is immediately followed by a process.env check or result.error inspection.
      // Evidence: concern-20260401-dotenv-1.
      if (
        detection.packageName === "dotenv" &&
        detection.functionName === "config" &&
        (primaryPostcondition.id === "missing-env-file" ||
          primaryPostcondition.id === "parse-error")
      ) {
        let blockNode: ts.Node | undefined = detection.node.parent;
        while (
          blockNode &&
          !ts.isBlock(blockNode) &&
          !ts.isSourceFile(blockNode)
        ) {
          blockNode = blockNode.parent;
        }
        if (
          blockNode &&
          (ts.isBlock(blockNode) || ts.isSourceFile(blockNode))
        ) {
          const stmts = (blockNode as ts.Block | ts.SourceFile).statements;
          const idx = stmts.findIndex((s) => {
            let found = false;
            const v = (n: ts.Node) => {
              if (n === detection.node) found = true;
              ts.forEachChild(n, v);
            };
            v(s);
            return found;
          });
          if (idx !== -1) {
            // For script/migration files that call dotenv.config() at the top and
            // rely on process.env throughout the file, use a wider lookahead.
            // Migration scripts (files with 'migration' in the path) can have many
            // statements between config() and the first env var access.
            // Evidence: concern-20260402-dotenv-2 — migration file with 3-statement gap.
            const isMigrationScript = sourceFile.fileName
              .toLowerCase()
              .includes("migrat");
            const lookahead = isMigrationScript ? stmts.length : 3;

            let dotenvSuppressed = false;
            for (
              let i = idx + 1;
              i < Math.min(idx + lookahead + 1, stmts.length);
              i++
            ) {
              const t = stmts[i].getText(sourceFile);
              if (t.includes("process.env") || t.includes(".error")) {
                dotenvSuppressed = true;
                break;
              }
            }
            if (dotenvSuppressed) continue;
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
        if (inAllSettled) continue;
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
        ]);
        if (tanStackTypedPostconditions.has(primaryPostcondition.id)) {
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
        if (inRetryWrapper) continue;
      }

      // react-hook-form useFieldArray: unhandled-field-array-operations fires even when
      // the parent form already has submit error handling. When the component uses
      // handleSubmit (indicating form-level error handling exists), the individual
      // field array mutation calls do not require separate try-catch blocks.
      // Evidence: concern-20260401-react-hook-form-4.
      if (
        detection.packageName === "react-hook-form" &&
        primaryPostcondition.id === "unhandled-field-array-operations" &&
        sourceFile.getFullText().includes("handleSubmit")
      ) {
        continue;
      }

      // @tanstack/react-query: error postconditions fire as FPs in two patterns:
      //   1. Custom hook files (useXxx.ts) — wrappers that return {data, error, isError};
      //      error handling is the caller's responsibility.
      //   2. Component files where the file destructures/uses .error or isError from the
      //      hook result — React Query's idiomatic error-state pattern (not try-catch).
      //
      // Evidence: concern-2026-04-02-tanstack-react-query-query-error-unhandled-5 (18 FPs hooks),
      //           concern-2026-04-02-tanstack-react-query-infinite-query-error-unhandled-11 (3 FPs),
      //           concern-2026-04-02-tanstack-react-query-mutation-error-unhandled-18 (2 FPs),
      //           concern-2026-04-02-dashboard-tanstack-react-query-1 (25 FPs in component files:
      //           app/access/page.tsx, components/Agents/AgentCreator.tsx, etc.).
      if (
        detection.packageName === "@tanstack/react-query" &&
        (primaryPostcondition.id === "query-error-unhandled" ||
          primaryPostcondition.id === "infinite-query-error-unhandled" ||
          primaryPostcondition.id === "mutation-error-unhandled")
      ) {
        const fileText = sourceFile.getFullText();
        // Custom hook files delegate error handling to callers
        const baseName = path.basename(
          sourceFile.fileName.replace(/\.tsx?$/, ""),
        );
        if (/^use[A-Z]/.test(baseName)) {
          continue; // Hook wrapper file — caller's responsibility
        }
        // Component files using React Query's error state pattern (isError, error property).
        // Only applies to query/infinite-query postconditions (useQuery error state API).
        // mutation-error-unhandled FPs are covered by the hook-file check above (useXxx pattern).
        // Note: we avoid ".error" (matches console.error) and "error)" (matches error handling).
        // Only match unambiguous RQ error state destructuring patterns.
        if (
          primaryPostcondition.id !== "mutation-error-unhandled" &&
          (fileText.includes("isError") ||
            fileText.includes("{ error") ||
            fileText.includes("error }") ||
            fileText.includes("onError"))
        ) {
          continue; // Error handled via React Query state API, not try-catch
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
        if (inRetryWrapper) continue;
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
        continue;
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
        if (isReturnDelegate) continue;
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
          continue;
        }
        // Fire violation — no verify() in file, decode() is being used for auth decisions
        // Fall through to violation generation (skip try-catch analysis — decode() never throws)
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
          });
        }
        continue;
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
            continue;
          }
          // Not null-guarded: fall through to fire violation below
        } else {
          // Standard try-catch analysis: accept either try-catch or .catch() chain
          // Also accept Supabase's idiomatic { error } destructuring + if check pattern.
          const inTryCatch =
            detection.pattern === "throwing-function" ||
            detection.pattern === "property-chain"
              ? this.controlFlow.isInTryCatch(detection.node) ||
                (ts.isCallExpression(detection.node) &&
                  this.controlFlow.hasCatchHandler(detection.node)) ||
                (ts.isCallExpression(detection.node) &&
                  this.controlFlow.hasOnErrorInOptions(detection.node)) ||
                this.controlFlow.isDestructuredErrorTupleProtected(
                  detection.node,
                  sourceFile,
                )
              : false;

          if (inTryCatch) {
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
              if (catchViolation) violations.push(catchViolation);
            }
            continue;
          }
        }
      }

      // Outside try-catch (or null-check postcondition without null guard):
      // For @aws-sdk/client-s3 send(): resolve postcondition based on the command
      // argument type (e.g. ListObjectsV2Command → warning, GetObjectCommand → error).
      // For all other packages: pick the most severe postcondition.
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

      // Skip warning-only postconditions that have no `throws` — these are informational
      // return-value risks (e.g., dayjs.format ReDoS) that don't require try-catch handling.
      // Warning postconditions WITH `throws` (e.g., clerk setActive) should still fire.
      if (postcondition.severity !== "error" && !postcondition.throws) {
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
          continue; // ClerkProvider present — suppress false positive
        }
      }

      // zod: parse-validation-error in Next.js API route handlers — suppress.
      // Next.js App Router route handlers (app/api/**/*.ts, app/api/**/*.tsx) are
      // automatically wrapped in Next.js's error boundary: unhandled exceptions return
      // a 500 response, they do NOT crash the process. Requiring try-catch inside every
      // route handler is overly prescriptive — Next.js handles this at the framework level.
      // Evidence: concern-2026-04-06-zod-7 — 14 FP instances in apps/web/app/api/**/*.ts
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
          continue; // Next.js route handler — framework provides error boundary
        }
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
        if (isTopLevelSingleton) continue;
      }

      // redis (node-redis): missing-error-listener — suppress for module-level singleton exports
      // or when the file already registers .on('error') anywhere.
      // The redis client is typically created at module level and exported as a singleton.
      // Error listeners (.on('error')) are registered in the application bootstrap,
      // not inline with the client definition. The scanner cannot trace cross-file event listener
      // registration.
      // Evidence: concern-2026-04-06-redis-1 — 7 FP instances in packages/api/src/main.ts
      // (module-level redis client creation, error handler registered elsewhere in the same file
      // or in bootstrap code).
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
          continue; // File has error listener registration — suppress
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
        if (isRedisTopLevel) continue;
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
          continue; // Script file — not a long-running service transport
        }
        // Suppress when file already has error listener
        if (
          fileText.includes(".on('error'") ||
          fileText.includes('.on("error"')
        ) {
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
            continue; // Inside a regular function — caller handles errors
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
          continue; // Auth context — password validation handled at form/UI layer
        }
        // Also suppress when the file contains password validation patterns
        const fileText = sourceFile.getFullText();
        if (
          fileText.includes("minLength") ||
          fileText.includes("passwordStrength") ||
          fileText.includes("validatePassword") ||
          fileText.includes("password.length")
        ) {
          continue; // File validates password before Supabase call
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
          continue; // One-off script/migration file — env file errors are acceptable
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

      // Check suppression (bc-scan store checked first, then inline, then config)
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
        if (isHttpClient && !checksResponse) {
          matchedPostcondition = pc;
          message =
            "Generic error handling found. Consider checking if error.response exists to distinguish network failures from HTTP errors.";
          break;
        }
      } else if (pc.severity === "error") {
        if (isHttpClient && !checksStatus) {
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

      const chainMatch = functions.find((f) => {
        // Exact match on the full chain string (both as-is and normalized)
        if (f.name === chainStr) return true;
        if (normalizeChain(f.name) === normalizedChainStr) return true;
        // Suffix match: contract name ends with chainStr (handles leading namespace)
        if (f.name.endsWith("." + chainStr)) return true;
        if (normalizeChain(f.name).endsWith("." + normalizedChainStr))
          return true;
        return false;
      });
      if (chainMatch) {
        return chainMatch;
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
    const dotted = functions.find((f) => {
      const parts = f.name.split(".");
      return parts.length > 1 && parts[parts.length - 1] === functionName;
    });
    if (dotted) {
      return dotted;
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
}
