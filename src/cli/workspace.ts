/**
 * CLI Command: workspace (qt-162)
 *
 * nark workspace                       — list all logged-in workspaces
 * nark workspace use <slug>            — set the default workspace
 * nark workspace use --here <slug>     — bind this repo via .nark/config.json
 * nark workspace rename <old> <new>    — local rename; errors if <new> exists
 */

import { Command } from "commander";
import * as fs from "fs";
import * as path from "path";
import {
  listWorkspaces,
  setDefault,
  renameWorkspace,
  readCredentialsV2,
} from "../lib/auth.js";

export function createWorkspaceCommand(): Command {
  const cmd = new Command("workspace");
  cmd.description("Manage logged-in nark workspaces");

  // qt-164 DEC7: typo suggestion (`nark workspace usse` → "Did you mean use?")
  cmd
    .showSuggestionAfterError(true)
    .showHelpAfterError("(add --help for additional usage)");

  // Default action (bare `nark workspace`) — list
  cmd.action(() => {
    const ws = listWorkspaces();
    if (ws.length === 0) {
      process.stderr.write("Not logged in. Run `nark login`.\n");
      process.exit(1);
    }
    for (const w of ws) {
      const marks = [
        w.isDefault ? "default" : null,
        w.isMostRecent ? "most-recent" : null,
      ]
        .filter(Boolean)
        .join(", ");
      const slugCol = w.slug.padEnd(20);
      const nameCol = w.workspace.orgName.padEnd(30);
      const emailCol = w.workspace.email;
      const tag = marks ? `  (${marks})` : "";
      console.log(`  ${slugCol} ${nameCol} ${emailCol}${tag}`);
    }
  });

  // `nark workspace use [--here] <slug>`
  const use = new Command("use");
  use
    .description("Set the default workspace (or bind this repo with --here)")
    .argument("<slug>", "workspace slug")
    .option(
      "--here",
      "Write .nark/config.json to the current directory (per-repo binding) instead of changing the global default",
    )
    .action((slug: string, opts: { here?: boolean }) => {
      const v2 = readCredentialsV2();
      if (!v2 || !v2.workspaces[slug]) {
        process.stderr.write(
          `Workspace \`${slug}\` not found. Run \`nark workspace\` to list available workspaces.\n`,
        );
        process.exit(1);
      }
      if (opts.here) {
        const dir = path.join(process.cwd(), ".nark");
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(
          path.join(dir, "config.json"),
          JSON.stringify({ workspace: slug }, null, 2),
        );
        console.log(
          `Bound this repo to workspace \`${slug}\` (wrote .nark/config.json).`,
        );
      } else {
        setDefault(slug);
        console.log(`Default workspace is now \`${slug}\`.`);
      }
    });

  // `nark workspace rename <old> <new>`
  const rename = new Command("rename");
  rename
    .description("Rename a local workspace alias")
    .argument("<old>", "current slug")
    .argument("<new>", "new slug")
    .action((oldSlug: string, newSlug: string) => {
      try {
        renameWorkspace(oldSlug, newSlug);
        console.log(`Renamed \`${oldSlug}\` to \`${newSlug}\`.`);
      } catch (err) {
        process.stderr.write(
          `${err instanceof Error ? err.message : String(err)}\n`,
        );
        process.exit(1);
      }
    });

  cmd.addCommand(use);
  cmd.addCommand(rename);
  return cmd;
}
