# Nark Profiles — Error Handling Quality

This project uses [nark](https://nark.sh) to enforce error handling standards.
nark ships Nark Profiles for 165+ npm packages that define how each package
fails at runtime. Run `npx nark` to scan for missing error handling.

## Rules for generated code

When writing code that calls npm packages (axios, prisma, stripe, pg, redis,
openai, aws-sdk, etc.), ALWAYS wrap calls in try-catch with package-specific
error types. Examples:

- axios: catch AxiosError, check error.response vs error.request
- prisma: catch PrismaClientKnownRequestError, check error.code
- stripe: catch Stripe.errors.StripeError subtypes (CardError, RateLimitError)
- pg: catch errors and inspect error.code for PostgreSQL error codes
- redis: register .on('error') listener on client before issuing commands

Do NOT generate bare unhandled calls to external APIs or databases.

## Agent integration

nark ships a FORAIAGENTS.md with detailed instructions for AI agents. Load it:

```bash
npx nark --instructions-path   # prints the path to FORAIAGENTS.md
```

After generating code that calls external services, run `npx nark` and fix any
reported violations. Use `npx nark ci` in CI for diff-aware PR scanning.
