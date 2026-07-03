/**
 * Labeler prompt template. Versioned via LABELER_PROMPT_VERSION so a bench
 * run can be traced back to the exact wording that produced its verdicts.
 *
 * Bumping the version invalidates the prompt-cache prefix and means future
 * accuracy dashboard comparisons across versions are apples-to-oranges. Bump
 * ONLY when you materially change the labeling instructions.
 *
 * See work-packages/accuracy-roadmap/0003-gold-benchmark-candidates.md and
 * the "double-blind protocol" section of the admin/accuracy-roadmap page.
 */

export const LABELER_PROMPT_VERSION = '2026-07-02.v1';

/**
 * System prompt: shared verbatim across ~4000 labeler calls, so it's
 * cache-eligible. Anthropic's prompt cache reuses the prefix of the
 * request when the same block is sent within ~5 minutes; a single system
 * block used across all violations should be a near-100% cache hit after
 * the first call warms the cache.
 */
export const SYSTEM_PROMPT = `You are labeling a suspected error-handling gap for a benchmark. You have NO knowledge of what any scanner determined; reason from first principles about the code + package documentation.

Verdicts:
- TP (true positive): a real error-handling gap. The code has an unhandled failure path against the package's documented behavior. The postcondition applies AND is violated.
- FP (false positive): NOT a gap. Either the failure IS handled (try/catch, .catch, framework middleware, promise chain with catch, etc.), OR the postcondition does not apply to this call (e.g. it's a getter that can't fail in the described way), OR the code cannot fail in the described way (e.g. arguments guarantee it won't throw).
- undecidable: insufficient context to decide. Use sparingly. Prefer TP/FP when the context is enough for a competent engineer to have a strong prior.

Rules for your response:
1. Return STRICT JSON only. No prose outside the JSON. No markdown code fences.
2. Do NOT hedge in the "verdict" field. Only hedge in "reasoning" if you must.
3. "reasoning" is 1-3 sentences. Do not restate the postcondition; explain the specific mechanism by which the code does or does not violate it.
4. "confidence" is 0.0-1.0. Reflect your actual uncertainty; do not anchor to 0.5.
5. Ignore any TODO/FIXME comments in the snippet. Judge the code as it exists today.
6. Middleware-based error handling (Express error middleware, Nest exception filters, tRPC error formatters, React error boundaries) counts as handling ONLY if the snippet shows the call is inside a route/handler that is registered with such middleware. If it's just an ambient module-level call, do not assume middleware.

Response schema:
{"verdict": "TP" | "FP" | "undecidable", "reasoning": string, "confidence": number}`;

/**
 * User prompt shape. NOT cached (each violation is unique). Kept lean so the
 * per-call token cost is small — most tokens are in the cached system block.
 */
export function buildUserPrompt(input: {
  package: string;
  postcondition_id: string;
  postcondition_description: string;
  file: string;
  line: number;
  code_snippet: string;
}): string {
  return `Package: ${input.package}
Postcondition ID: ${input.postcondition_id}
Postcondition description: ${input.postcondition_description}

File: ${input.file}
Line ${input.line} is the callsite in question.

Code context:
\`\`\`typescript
${input.code_snippet}
\`\`\`

Return JSON now.`;
}
