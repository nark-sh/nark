/**
 * CLI Command: whoami (qt-162)
 *
 * Prints the active nark workspace and the resolution source.
 *
 * Output (4 lines, plain text):
 *   <email>
 *   <orgName> (<orgSlug>)
 *   <plan>
 *   source: <env|flag|config|narkrc|default|single>
 */

import { Command } from "commander";
import { resolveActiveWorkspace } from "../lib/auth.js";

export function createWhoamiCommand(): Command {
  const cmd = new Command("whoami");
  cmd.description("Show the active workspace and resolution source");
  cmd.action(() => {
    // Read --org/-w flag from the parent program if present
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const parent: any = (cmd.parent as any) ?? null;
    const orgSlug =
      parent?.opts?.()?.org ?? parent?.opts?.()?.workspace ?? undefined;

    const r = resolveActiveWorkspace({ orgSlug, cwd: process.cwd() });
    if (!r) {
      process.stderr.write("Not logged in. Run `nark login`.\n");
      process.exit(1);
    }

    if (r.source === "env") {
      const envName = process.env.NARK_API_KEY ? "NARK_API_KEY" : "NARK_TOKEN";
      console.log(`(authenticated via ${envName} env var)`);
      console.log(`source: env`);
      process.exit(0);
    }

    const w = r.workspace!;
    console.log(w.email);
    console.log(`${w.orgName} (${w.orgSlug})`);
    console.log(w.plan);
    console.log(`source: ${r.source}`);
  });
  return cmd;
}
