/**
 * AI Agent Prompt Generator
 *
 * Generates a comprehensive prompt file for AI agents to review violations,
 * identify false positives, and create an action plan for fixes.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { AuditRecord } from './types.js';

/**
 * Generate AI agent prompt file
 *
 * @param auditRecord - The audit record from analysis
 * @param outputPath - Path to the output directory
 * @returns Path to the generated prompt file, or null if no violations found
 */
export async function generateAIPrompt(
  auditRecord: AuditRecord,
  outputPath: string
): Promise<string | null> {
  const violationCount = auditRecord.violations.length;

  // Skip generation if there are no violations - nothing to review!
  if (violationCount === 0) {
    return null;
  }

  const outputDir = path.dirname(outputPath);
  const promptPath = path.join(outputDir, 'ai-agent-prompt.md');
  const indexHtmlPath = path.join(outputDir, 'index.html');

  const errorCount = auditRecord.violations.filter(v => v.severity === 'error').length;
  const warningCount = auditRecord.violations.filter(v => v.severity === 'warning').length;

  // Extract project name from tsconfig path
  // Handle both directory paths and file paths correctly
  let projectDir: string;
  if (auditRecord.tsconfig.endsWith('tsconfig.json')) {
    // If it's a file path, use the parent directory
    projectDir = path.dirname(auditRecord.tsconfig);
  } else {
    // If it's a directory path, use it directly
    projectDir = auditRecord.tsconfig;
  }
  const projectName = path.basename(path.resolve(projectDir));

  const prompt = `# AI Agent Instructions: Nark Violation Review

**Project:** ${projectName}
**Scan Date:** ${new Date(auditRecord.timestamp).toLocaleString()}
**Total Violations:** ${violationCount} (${errorCount} errors, ${warningCount} warnings)

---

## Important: Working Directory

All analysis files and reports are stored in the \`.nark/\` directory at the project root.

**This directory is automatically:**
- Created for you
- Added to \`.gitignore\` (won't be committed by default)
- Safe for storing analysis results, fix proposals, and documentation

**Recommendation:** Save any analysis files (reports, fix proposals, notes) to \`.nark/analysis/\` so they're organized and won't clutter the codebase.

---

## Your Mission

1. **Review all violations** - Check if each is a true positive or false positive
2. **Suppress false positives** - Mark invalid violations using the suppression system
3. **Create action plan** - Propose fixes for real violations
4. **Verify fixes** - Re-run the analyzer to confirm everything is resolved

---

## Step 1: Review Violations

### Where to Find Results

📊 **Interactive Visualization (Recommended):**
Open this file in your browser:
\`\`\`
file://${indexHtmlPath}
\`\`\`

📄 **Full Report:**
\`\`\`bash
cat ${path.relative(process.cwd(), path.join(outputDir, 'output.txt'))}
\`\`\`

📋 **JSON Data:**
\`\`\`bash
cat ${path.relative(process.cwd(), outputPath)}
\`\`\`

### How to Review

For each violation, ask:

1. **Is this a real issue?**
   - Does the code lack proper error handling?
   - Would this cause problems in production?
   - Is the contract's requirement valid?

2. **Is this a false positive?**
   - Does a framework handle this error?
   - Is there a global error handler?
   - Is this test code that intentionally triggers errors?
   - Does the analyzer misunderstand the code pattern?

---

## Step 2: Suppress False Positives

### Method A: Inline Comment (Recommended for Specific Cases)

Add a comment **before** the violating line:

\`\`\`typescript
// @behavioral-contract-ignore <package>/<postcondition-id>: <reason>
await problematicCode();
\`\`\`

**Examples:**

\`\`\`typescript
// @behavioral-contract-ignore axios/network-failure: Global error handler in src/middleware/errors.ts handles all network failures
const response = await axios.get('/api/data');

// @behavioral-contract-ignore @prisma/client/p2002: NestJS exception filter handles unique constraint violations
await prisma.user.create({ data });

// @behavioral-contract-ignore */timeout-not-set: Timeout configured globally in axios.defaults.timeout
await axios.post('/api/users', userData);
\`\`\`

### Method B: Config File (Recommended for Global Rules)

Create \`.narkrc.json\` in project root:

\`\`\`json
{
  "ignore": [
    {
      "file": "src/test/**",
      "reason": "Test files intentionally trigger errors to validate error handling"
    },
    {
      "file": "**/*.test.ts",
      "reason": "Test files"
    },
    {
      "file": "**/*.spec.ts",
      "reason": "Test files"
    },
    {
      "package": "axios",
      "postconditionId": "network-failure",
      "file": "src/api/legacy.ts",
      "reason": "Legacy code with global error handler - refactor scheduled for Q3 2026"
    }
  ]
}
\`\`\`

### Suppression Best Practices

✅ **DO:**
- Provide meaningful, specific reasons (minimum 10 characters)
- Reference where the error is actually handled
- Include ticket numbers for planned fixes (e.g., "TODO: Fix in JIRA-1234")
- Use config file for entire directories (tests, legacy)
- Use inline comments for specific exceptions

❌ **DON'T:**
- Use vague reasons like "false positive" or "not needed"
- Suppress legitimate errors without good justification
- Use wildcards excessively (\`*/*\` suppresses everything!)
- Forget to document WHY it's safe to suppress

---

## Step 3: Create Action Plan

### Categorize Violations

**Group by Package:**
\`\`\`
axios violations: 12
  - network-failure: 8
  - timeout-not-set: 4

@prisma/client violations: 5
  - p2002 (unique constraint): 3
  - p2025 (not found): 2
\`\`\`

**Group by Severity:**
\`\`\`
Errors (critical): 8
Warnings (important): 4
\`\`\`

### Prioritize Fixes

1. **Critical Errors** - Production crashes
2. **High-Frequency Patterns** - Same mistake repeated
3. **Simple Wins** - Easy fixes with big impact
4. **Warnings** - Important but not urgent

### Fix Strategies

**Strategy 1: Create Wrapper Functions**

Instead of fixing each instance:

\`\`\`typescript
// utils/api.ts
import axios, { AxiosRequestConfig } from 'axios';

export async function apiGet<T>(url: string, config?: AxiosRequestConfig): Promise<T> {
  try {
    const response = await axios.get(url, config);
    return response.data;
  } catch (error) {
    if (axios.isAxiosError(error)) {
      if (error.response) {
        throw new ApiError(\`HTTP \${error.response.status}: \${error.response.statusText}\`, error.response.status);
      } else if (error.request) {
        throw new NetworkError('Network request failed');
      }
    }
    throw error;
  }
}

// Usage everywhere
const user = await apiGet<User>('/api/users/123'); // ✅ Error handling built-in
\`\`\`

**Strategy 2: Use Interceptors**

For axios violations:

\`\`\`typescript
// config/axios.ts
import axios from 'axios';

axios.interceptors.response.use(
  (response) => response,
  (error) => {
    if (axios.isAxiosError(error)) {
      if (error.response?.status === 429) {
        return handleRateLimit(error);
      }
      if (!error.response) {
        console.error('Network error:', error.message);
      }
    }
    return Promise.reject(error);
  }
);
\`\`\`

Then suppress violations with:
\`\`\`typescript
// @behavioral-contract-ignore axios/*: Global interceptor handles all errors (see config/axios.ts)
\`\`\`

**Strategy 3: Framework Exception Filters**

For NestJS, create a global filter:

\`\`\`typescript
// filters/prisma-exception.filter.ts
@Catch(PrismaClientKnownRequestError)
export class PrismaExceptionFilter implements ExceptionFilter {
  catch(exception: PrismaClientKnownRequestError, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse();

    switch (exception.code) {
      case 'P2002':
        return response.status(409).json({
          message: 'Unique constraint violation',
          field: exception.meta?.target
        });
      // ... handle other codes
    }
  }
}
\`\`\`

Then suppress with config file:
\`\`\`json
{
  "ignore": [{
    "package": "@prisma/client",
    "file": "src/api/**",
    "reason": "Global PrismaExceptionFilter handles all database errors"
  }]
}
\`\`\`

---

## Step 4: Implement Fixes

### Example Report Format

\`\`\`markdown
# Nark Violations - Fix Report

## Summary
- Total Violations: ${violationCount}
- False Positives: [TBD after review]
- Actual Issues: [TBD after review]

## False Positives (Suppressed)

### 1. Test Files (8 violations)
**Reason:** Test files intentionally trigger errors to validate error handling
**Action:** Created \`.narkrc.json\` with test file pattern
**Files:** src/test/**, **/*.test.ts, **/*.spec.ts

### 2. Global Error Handler (3 violations)
**Reason:** Express error middleware handles all axios errors
**Location:** src/middleware/error-handler.ts
**Action:** Added inline suppressions with reference to middleware
**Files:**
- src/api/users.ts:42
- src/api/posts.ts:78
- src/api/auth.ts:123

## Actual Issues (Fixed)

### 1. Missing Try-Catch in API Routes (5 violations)
**Strategy:** Created \`apiGet\` wrapper function
**Files:**
- Created: src/utils/api.ts (wrapper)
- Updated: src/api/products.ts, src/api/orders.ts, src/api/customers.ts
**Test:** ✅ Manual testing confirms error handling works

### 2. Missing Prisma Error Handling (3 violations)
**Strategy:** Created NestJS exception filter
**Files:**
- Created: src/filters/prisma-exception.filter.ts
- Updated: src/app.module.ts (registered filter globally)
**Test:** ✅ Unit tests added, all passing

## Testing

\`\`\`bash
# Re-run analyzer
npx nark --tsconfig ./tsconfig.json

# Result: 0 violations ✅
\`\`\`
\`\`\`

---

## Step 5: Verify Fixes

After implementing fixes and suppressions, re-run:

\`\`\`bash
npx nark --tsconfig ./tsconfig.json --check-dead-suppressions
\`\`\`

**Expected Results:**
- ✅ All real violations fixed (0 errors)
- ✅ False positives suppressed
- ✅ No dead suppressions (yet - they appear after analyzer upgrades)

---

## Advanced: Suppression Management

### List All Suppressions

\`\`\`bash
npx nark suppressions list
\`\`\`

### Show Suppression Statistics

\`\`\`bash
npx nark suppressions stats
\`\`\`

### Check for Dead Suppressions

\`\`\`bash
npx nark --tsconfig ./tsconfig.json --check-dead-suppressions
\`\`\`

Dead suppressions are suppressions that are no longer needed because the analyzer has improved.

### Clean Up Dead Suppressions

\`\`\`bash
npx nark suppressions clean --auto
\`\`\`

---

## Common Patterns to Look For

### ✅ Valid Suppressions

**Global Error Handler:**
\`\`\`typescript
// @behavioral-contract-ignore axios/*: Global error middleware (src/middleware/errors.ts)
\`\`\`

**Framework Exception Filter:**
\`\`\`typescript
// @behavioral-contract-ignore @prisma/client/*: NestJS PrismaExceptionFilter handles all errors
\`\`\`

**Test Code:**
\`\`\`json
{ "file": "**/*.test.ts", "reason": "Test files" }
\`\`\`

**Legacy Code with Plan:**
\`\`\`typescript
// @behavioral-contract-ignore */*: Legacy code - scheduled for refactor in Q3 2026 (JIRA-1234)
\`\`\`

### ❌ Invalid Suppressions (Don't Do This)

**Lazy Suppression:**
\`\`\`typescript
// @behavioral-contract-ignore axios/network-failure: false positive
// ❌ Doesn't explain WHY it's safe
\`\`\`

**Hiding Real Issues:**
\`\`\`typescript
// @behavioral-contract-ignore axios/network-failure: TODO fix later
// ❌ Suppressing a real bug without a plan
\`\`\`

**Overly Broad:**
\`\`\`typescript
// @behavioral-contract-ignore */*: not needed
// ❌ Suppresses EVERYTHING - defeats the purpose
\`\`\`

---

## Resources

📚 **Documentation:**
- Suppression System Guide: [docs/cli-reference/suppressions.md](https://github.com/nark-sh/nark/blob/main/docs/cli-reference/suppressions.md)
- Fixing Violations: [docs/getting-started/fixing-violations.md](https://github.com/nark-sh/nark/blob/main/docs/getting-started/fixing-violations.md)

🔧 **Tools:**
- Interactive Visualization: file://${indexHtmlPath}
- Full Report: ${path.relative(process.cwd(), path.join(outputDir, 'output.txt'))}
- JSON Data: ${path.relative(process.cwd(), outputPath)}

---

## Your Task Checklist

- [ ] Review all ${violationCount} violations using the interactive visualization
- [ ] Identify false positives (framework-handled, global handlers, test code)
- [ ] Add suppressions for false positives (inline comments or config file)
- [ ] Categorize real violations by package and severity
- [ ] Create fix strategy (wrappers, interceptors, filters, or direct fixes)
- [ ] Implement fixes following best practices
- [ ] Re-run analyzer to verify: \`npx nark --tsconfig ./tsconfig.json\`
- [ ] Create detailed report of changes made
- [ ] Document any suppressions in code comments

---

**Good luck! 🚀**

*Generated by nark v${auditRecord.tool_version}*
`;

  await fs.promises.writeFile(promptPath, prompt, 'utf-8');

  return promptPath;
}
