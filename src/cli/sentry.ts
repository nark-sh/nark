import * as Sentry from "@sentry/node";
import os from "os";

// This DSN is a public client key (by Sentry's design) — safe to embed in
// published npm packages. It identifies the project, not the org secret.
// Override at runtime with SENTRY_DSN env var for testing.
const DEFAULT_DSN =
  "https://50cc3abcd7275a1721f4d85a531b04d0@o4511412606402560.ingest.us.sentry.io/4511412642840576";

/**
 * Check if Sentry reporting is disabled via environment variable.
 * Mirrors the telemetry opt-out pattern in src/cli/telemetry.ts:180-192.
 */
export function isSentryDisabled(): boolean {
  if (process.env["NARK_SENTRY"] === "off") return true;
  const tel = (process.env["NARK_TELEMETRY"] || "").toLowerCase();
  if (tel === "off" || tel === "false" || tel === "0") return true;
  if (process.env["DO_NOT_TRACK"] === "1") return true;
  return false;
}

/**
 * Initialize Sentry for the nark CLI.
 * Call once at startup, right after handleFirstRunNotice().
 * Wrapped in try/catch — never crashes the CLI on init failure.
 */
export function initSentry(): void {
  if (isSentryDisabled()) return;
  try {
    const dsn = process.env["SENTRY_DSN"] || DEFAULT_DSN;
    if (!dsn) return;
    Sentry.init({
      dsn,
      sendDefaultPii: false,
      // No performance tracing — avoids burning the 5M spans/month free quota.
      tracesSampleRate: 0,
      // Sample 25% of errors to stretch the 5,000 errors/month free quota across
      // an unknown user base. Adjust after seeing first-month volume.
      sampleRate: 0.25,
      // Don't hang user terminals on exit — flush within 2 seconds.
      shutdownTimeout: 2000,
      release: process.env["npm_package_version"],
      beforeSend(event) {
        // Strip user homedir from all path strings so local paths aren't sent.
        const home = os.homedir();
        const scrub = (s: string | undefined): string | undefined =>
          typeof s === "string" ? s.split(home).join("~") : s;

        // Remove machine-identifying context fields.
        if (event.contexts?.runtime) delete event.contexts.runtime;
        if (event.contexts?.os) delete event.contexts.os;
        if (event.server_name) event.server_name = "[scrubbed]";
        if (event.user) event.user = undefined;

        // Scrub file paths in stack frames.
        if (event.exception?.values) {
          for (const ex of event.exception.values) {
            if (ex.stacktrace?.frames) {
              for (const f of ex.stacktrace.frames) {
                f.filename = scrub(f.filename);
                f.abs_path = scrub(f.abs_path);
              }
            }
          }
        }

        // Scrub breadcrumb messages.
        if (event.breadcrumbs) {
          for (const b of event.breadcrumbs) {
            if (b.message) b.message = scrub(b.message) ?? b.message;
          }
        }

        return event;
      },
    });
  } catch {
    // Never crash the CLI on a Sentry init failure.
  }
}

/**
 * Capture an exception to Sentry.
 * Safe to call even if Sentry is disabled — will no-op.
 */
export function captureCliException(err: unknown): void {
  if (isSentryDisabled()) return;
  try {
    Sentry.captureException(err);
  } catch {
    // swallow — Sentry must never interfere with CLI exit behavior
  }
}

/**
 * Flush any pending Sentry events and close the SDK.
 * Call before process.exit() to ensure events are sent.
 * Resolves in at most 2 seconds (shutdownTimeout).
 */
export async function flushSentry(): Promise<void> {
  try {
    await Sentry.close(2000);
  } catch {
    // swallow
  }
}
