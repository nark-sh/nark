# Security Policy

We take the security of nark seriously. nark is a static-analysis CLI that runs on developer machines and in CI; a compromise of the published package would compromise every downstream user. This policy describes how to report a vulnerability and what to expect in response.

## Supported versions

We accept security reports against the latest published minor version on npm. Earlier versions are not patched — upgrade to the latest minor first if you are on an older release.

| Version | Supported |
|---------|-----------|
| 3.x     | Yes       |
| < 3.0   | No        |

## Scope

In scope:

- The `nark` CLI itself (everything under `bin/`, `dist/`, `src/`)
- The published npm package — supply-chain integrity, install behavior, the `files` allowlist
- The telemetry transport (the HTTPS call to `https://app.nark.sh/api/telemetry/scan`) and the data sent in it
- The CI workflows that build and publish the package

Out of scope (please do not report):

- False positives or false negatives in scan results — those are bugs, file a normal issue
- Issues in `nark-corpus` profile content — file at https://github.com/nark-sh/nark-corpus/issues
- Issues in the SaaS app at `app.nark.sh` — separate disclosure path, contact `security@nark.sh`

## How to report

**Do not open a public GitHub issue for security reports.** Public issues are visible to attackers immediately.

Email: **security@nark.sh**

If you would like to encrypt your report, request the current PGP key in your first message and we will reply with the fingerprint before you send the report.

Include in your report:

- A description of the vulnerability and its impact
- Steps to reproduce (a minimal failing case is ideal)
- The nark version and Node.js version you tested against
- Any suggested remediation (optional)

## What to expect

| Step | SLA |
|------|-----|
| Acknowledgement of receipt | within 48 hours |
| Initial triage and severity assessment | within 5 business days |
| Fix released (high/critical) | as fast as we can responsibly ship — typically within 7 days of triage |
| Public disclosure / advisory | coordinated with the reporter, typically 7–30 days after the fix is published |

If you have not heard back within 48 hours, please re-send your report. Email can fail silently.

## Recognition

We will credit reporters in the published GitHub Security Advisory unless you ask to remain anonymous. We do not currently run a paid bug bounty program.

## Defense-in-depth notes for users

nark itself follows several practices that limit blast radius if something goes wrong:

- **No install/preinstall/postinstall scripts.** `npm install nark` runs zero code on your machine.
- **Explicit `files` allowlist.** Verifiable with `npm pack --dry-run nark` — only `bin/`, `dist/`, `schema/`, `demo/`, `FORAIAGENTS.md` ship in the tarball.
- **Minimal production dependency surface** (currently 9 packages). `npm ls --prod` from a fresh install shows the full transitive list.
- **Telemetry opt-out** via `nark telemetry off`, `NARK_TELEMETRY=off`, or `DO_NOT_TRACK=1`. The full schema of what is and is not collected is documented at https://nark.sh/telemetry.

For a continuously-updated third-party view of nark's supply-chain posture, see the Socket page at https://socket.dev/npm/package/nark and the OpenSSF Scorecard at https://scorecard.dev/viewer/?uri=github.com/nark-sh/nark.
