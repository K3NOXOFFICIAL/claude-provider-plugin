import { Command } from "commander";
import chalk from "chalk";
import {
  listProfiles,
  detectActiveProfile,
  switchProfile,
  duplicateProfile,
  addClaudeAccount,
} from "./profiles.js";
import { runInteractiveMenu } from "./interactive.js";
import { mcpServer } from "./mcp.js";
import {
  saveCredentialForProfile,
  restoreCredentialForProfile,
  listSavedCredentials,
  clearLogin,
} from "./credentials.js";

function fail(message: string): never {
  console.error(chalk.red(message));
  process.exit(1);
}

/**
 * Display list of installed providers
 */
function showProviderList(): void {
  const profiles = listProfiles();

  console.log(chalk.bold("Installed providers:"));

  if (!profiles || profiles.length === 0) {
    console.log(chalk.dim("  No providers installed. Run claude-provider to add one."));
    return;
  }

  const active = detectActiveProfile(profiles);
  const saved = new Set(listSavedCredentials());

  for (const profile of profiles) {
    const marker = profile.name === active ? chalk.green(" (active)") : "";
    const login = saved.has(profile.name) ? chalk.dim(" [login saved]") : "";
    console.log(` - ${profile.name}${marker}${login}`);
  }
}

/**
 * Direct switch to a provider by name
 */
function directSwitch(name: string): void {
  const profile = listProfiles().find((p) => p.name.toLowerCase() === name.toLowerCase());

  if (!profile) {
    console.error(chalk.red(`Provider not installed: ${name}`));
    console.error(chalk.dim('Tip: run "claude-provider" or "cpr" to add providers interactively.'));
    process.exit(1);
  }

  const { notes } = switchProfile(profile.name);
  console.log(`✅ Switched to ${chalk.cyan(profile.name)}. Run "claude" then /status.`);
  for (const note of notes) console.log(chalk.dim(`   (${note})`));
}

/**
 * Handle `cpr credential <action> [profile]` subcommand.
 */
function handleCredentialCommand(action: string, profile?: string): void {
  switch (action) {
    case "save": {
      if (!profile) fail("Usage: cpr credential save <profile>");
      const result = saveCredentialForProfile(profile);
      if (!result.saved) fail(`Failed: ${result.reason}`);
      console.log(`✅ Saved login for ${chalk.cyan(profile)} → ${result.path}`);
      return;
    }
    case "restore": {
      if (!profile) fail("Usage: cpr credential restore <profile>");
      const result = restoreCredentialForProfile(profile);
      if (!result.restored) fail(`Failed: ${result.reason}`);
      console.log(`✅ Restored login for ${chalk.cyan(profile)} from ${result.path}`);
      return;
    }
    case "clear": {
      clearLogin();
      console.log("✅ Logged out locally. Run claude, then /login.");
      return;
    }
    case "list": {
      const saved = listSavedCredentials();
      if (saved.length === 0) {
        console.log(chalk.dim("No saved logins. Run `cpr credential save <profile>`."));
        return;
      }
      console.log(chalk.bold("Saved logins:"));
      for (const name of saved) {
        console.log(` - ${name}`);
      }
      return;
    }
    default:
      console.error(chalk.red(`Unknown action: ${action}`));
      console.error(chalk.dim("Available: save, restore, clear, list"));
      process.exit(1);
  }
}

/**
 * Create and configure the CLI program
 */
export function createProgram(): Command {
  return new Command()
    .name("claude-provider")
    .description("CLI tool to switch between Claude Code API providers and Claude accounts")
    .version("0.1.0")
    .argument(
      "[provider]",
      "provider name to switch to, or: mcp | credential | duplicate | add-account"
    )
    .argument("[arg1]", "credential: save|restore|clear|list; duplicate: source; add-account: name")
    .argument("[arg2]", "credential: profile; duplicate: new name")
    .option("-l, --list", "list installed providers")
    .option("--with-credentials", "duplicate: also copy the saved Claude login");
}

/**
 * Run the CLI application
 */
export async function runCli(): Promise<void> {
  const program = createProgram();
  program.parse(process.argv);

  const opts = program.opts<{ list?: boolean; withCredentials?: boolean }>();
  const [provider, arg1, arg2] = program.args;

  if (opts.list) {
    showProviderList();
    return;
  }

  if (provider == "mcp") {
    return mcpServer();
  }

  if (provider === "credential") {
    if (!arg1) fail("Usage: cpr credential <save|restore|clear|list> [profile]");
    handleCredentialCommand(arg1, arg2);
    return;
  }

  if (provider === "duplicate") {
    if (!arg1 || !arg2) fail("Usage: cpr duplicate <source> <new-name> [--with-credentials]");
    try {
      const file = duplicateProfile(arg1, arg2, { withCredentials: opts.withCredentials });
      console.log(`✅ Duplicated ${chalk.cyan(arg1)} → ${chalk.cyan(arg2)} (${file})`);
    } catch (e) {
      fail(e instanceof Error ? e.message : String(e));
    }
    return;
  }

  if (provider === "add-account") {
    if (!arg1) fail("Usage: cpr add-account <name>");
    try {
      for (const note of addClaudeAccount(arg1)) console.log(`✅ ${note}`);
    } catch (e) {
      fail(e instanceof Error ? e.message : String(e));
    }
    return;
  }

  if (provider) {
    directSwitch(provider);
    return;
  }

  await runInteractiveMenu();
}

runCli().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
