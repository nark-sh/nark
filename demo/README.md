# Nark demo fixture

This directory ships with the `nark` npm package as a self-contained sample
project. When you run `npx nark --demo`, the scanner uses this directory's
`tsconfig.json` instead of yours and walks through the three source files in
`src/` looking for missing error-handling around calls into popular npm
packages (`axios`, `stripe`, `@prisma/client`).

The intent is "see what a real Nark scan output looks like in 60 seconds,
without setting up your own project."

## Files

| File | What it demonstrates |
|------|----------------------|
| `src/api-client.ts` | `axios.get()` / `axios.post()` without `try/catch`; one site catches errors but doesn't handle `429 Too Many Requests` |
| `src/payments.ts` | `stripe.charges.create()` / `stripe.customers.create()` without `try/catch` — silent failure on declined cards |
| `src/users.ts` | `prisma.user.create()` / `prisma.user.findUnique()` without `try/catch` — duplicate-email `P2002` not handled |
| `types.d.ts` | Ambient module declarations so the demo is self-contained (no `npm install` required to run the scan) |
| `tsconfig.json` | Standalone TS project pointed at `src/*.ts` + the ambient declarations |

## Reproducing a real run

```bash
npx nark --demo
```

Or, if you've already cloned `nark-sh/nark`:

```bash
npx nark --tsconfig demo/tsconfig.json
```

The output is the same as what you'd see scanning your own project — just
against a curated set of intentional violations, so the report is never
empty.
