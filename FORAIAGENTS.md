# FORAIAGENTS.md — Instructions for AI Code Agents

## What is nark?

nark is a contract coverage scanner for npm packages. It analyzes TypeScript code
to find missing error handling patterns (try/catch, .on('error'), etc.) based on
a curated library of contracts that describe how packages fail at runtime.

## After a scan

When nark reports violations, each one represents a place where error handling
is missing or incomplete. To fix violations:

1. Read the violation details in `.nark/violations/<package>/`
2. Add appropriate error handling (try/catch, error listeners, etc.)
3. Re-run nark to verify the fix
4. Mark false positives with: `nark triage mark <fingerprint> false-positive --reason "..."`

## Triage

You can update violation files in `.nark/violations/` with triage information:
- `verdict`: true-positive, false-positive, or wont-fix
- `reason`: explanation of why
- `triaged_by`: your identifier
- `triaged_at`: ISO timestamp

## More info

Run `nark --help` for all available commands and options.
