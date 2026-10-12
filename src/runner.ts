import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import type { Settings } from "./types.js";
import { getClaudeDir, getClaudeJsonPath, getSettingsPath, readSettings, writeSettings, normalizeBaseUrl } from "./utils.js";
import { getProfileFilePath, isOauthProfile, mergeProfileSettings } from "./profiles.js";
import { PROXY_ADDON_PY } from "./proxy-addon.js";

/**
 * Run several Claude Code sessions side by side.
 *
 * Each profile gets its own CLAUDE_CONFIG_DIR (~/.claude-accounts/<name>), so
 * two claude.ai accounts can be logged in at once, each with Remote Control.
 *
 * Split mode (`--inference B`): the session keeps profile A's claude.ai login
 * (so Remote Control stays on) while a local mitmproxy rewrites only the
 * inference call (POST /v1/messages) to go out through profile B, which is
 * either a second Claude account or any Anthropic-compatible /v1 gateway.
 * Setting ANTHROPIC_BASE_URL instead would disable Remote Control.
 */

const SHARED_ENTRIES = ["skills", "commands", "agents", "plugins", "projects"];
const AUTH_ENV = ["ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY"];

export function getAccountsRoot(): string {
  return path.join(os.homedir(), ".claude-accounts");
}

export function getAccountDir(name: string): string {
  return path.join(getAccountsRoot(), name);
}

function link(src: string, dest: string): void {
  if (!fs.existsSync(src) || fs.existsSync(dest)) return;
  try {
    fs.symlinkSync(src, dest, "junction");
  } catch {
    // Sharing is a convenience; the profile still works without it.
  }
}

/**
 * Create/refresh the isolated config dir for a profile: shared skills,
 * commands, agents, plugins and project memory are linked from ~/.claude,
 * settings.json is the user's base settings plus the profile.
 */
export function prepareAccountDir(name: string, opts: { share?: boolean } = {}): string {
  const dir = getAccountDir(name);
  fs.mkdirSync(dir, { recursive: true });

  const profile = readSettings(getProfileFilePath(name));
  if (!profile) throw new Error(`Provider profile not found: settings.${name}.json`);

  const ownSettings = path.join(dir, "settings.json");
  const base = readSettings(fs.existsSync(ownSettings) ? ownSettings : getSettingsPath());
  writeSettings(ownSettings, mergeProfileSettings(base, profile));

  if (opts.share !== false) {
    for (const entry of SHARED_ENTRIES) link(path.join(getClaudeDir(), entry), path.join(dir, entry));
    const md = path.join(dir, "CLAUDE.md");
    const srcMd = path.join(getClaudeDir(), "CLAUDE.md");
    if (!fs.existsSync(md) && fs.existsSync(srcMd)) fs.copyFileSync(srcMd, md);
  }

  // User-scope MCP servers and trust state live in .claude.json; seed it once, minus the login.
  const ownJson = path.join(dir, ".claude.json");
  if (!fs.existsSync(ownJson) && fs.existsSync(getClaudeJsonPath())) {
    try {
      const json = JSON.parse(fs.readFileSync(getClaudeJsonPath(), "utf8")) as Record<string, unknown>;
      delete json.oauthAccount;
      fs.writeFileSync(ownJson, JSON.stringify(json, null, 2) + "\n");
    } catch {
      // Claude will create a fresh one.
    }
  }
  return dir;
}

export function buildClaudeEnv(
  name: string,
  dir: string,
  base: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base, CLAUDE_CONFIG_DIR: dir };
  if (isOauthProfile(readSettings(getProfileFilePath(name)))) {
    // Inherited gateway vars would disable Remote Control and bypass the login.
    for (const key of AUTH_ENV) delete env[key];
  }
  return env;
}

export function extractApiKey(settings: Settings): string | null {
  const direct = settings.env?.ANTHROPIC_AUTH_TOKEN ?? settings.env?.ANTHROPIC_API_KEY;
  if (direct) return direct;
  const m = settings.apiKeyHelper?.match(/^bash -c 'echo (.*)'$/s);
  return m ? m[1].replace(/'\\''/g, "'") : null;
}

export interface ProxyConfig {
  mode: "gateway" | "oauth";
  scheme?: string;
  host?: string;
  port?: number;
  basePath?: string;
  token?: string;
  credentialsFile?: string;
  forceModel?: string;
  tiers: { opus?: string; sonnet?: string; haiku?: string };
}

/**
 * Describe where the inference calls of a split session should go.
 */
export function buildProxyConfig(inference: string, opts: { model?: string } = {}): ProxyConfig {
  const settings = readSettings(getProfileFilePath(inference));
  if (!settings) throw new Error(`Provider profile not found: settings.${inference}.json`);
  const env = settings.env ?? {};
  const tiers = {
    opus: env.ANTHROPIC_DEFAULT_OPUS_MODEL || undefined,
    sonnet: env.ANTHROPIC_DEFAULT_SONNET_MODEL || undefined,
    haiku: env.ANTHROPIC_DEFAULT_HAIKU_MODEL || undefined,
  };

  if (isOauthProfile(settings)) {
    const credentialsFile = path.join(getAccountDir(inference), ".credentials.json");
    if (process.platform === "darwin") {
      throw new Error("Using a second Claude account for inference is not supported on macOS (keychain).");
    }
    return { mode: "oauth", credentialsFile, forceModel: opts.model, tiers: {} };
  }

  const baseUrl = env.ANTHROPIC_BASE_URL;
  const token = extractApiKey(settings);
  if (!baseUrl || !token) {
    throw new Error(`Profile ${inference} needs ANTHROPIC_BASE_URL and an API key to serve inference.`);
  }
  const url = new URL(normalizeBaseUrl(baseUrl).url);
  return {
    mode: "gateway",
    scheme: url.protocol.replace(":", ""),
    host: url.hostname,
    port: url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80,
    basePath: url.pathname.replace(/\/+$/, ""),
    token,
    forceModel: opts.model,
    tiers,
  };
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address() as net.AddressInfo;
      srv.close(() => resolve(port));
    });
  });
}

function waitForPort(port: number, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  return new Promise((resolve) => {
    const attempt = (): void => {
      const sock = net.connect(port, "127.0.0.1");
      sock.once("connect", () => {
        sock.destroy();
        resolve(true);
      });
      sock.once("error", () => {
        sock.destroy();
        if (Date.now() > deadline) resolve(false);
        else setTimeout(attempt, 200);
      });
    };
    attempt();
  });
}

function findMitmdump(): string | null {
  const bin = process.env.CPR_MITMDUMP || "mitmdump";
  const res = spawnSync(bin, ["--version"], { stdio: "ignore" });
  return res.error || res.status !== 0 ? null : bin;
}

function claudeBin(): string {
  return process.env.CPR_CLAUDE_BIN || "claude";
}

function forwardExit(child: ChildProcess, cleanup: () => void): Promise<number> {
  return new Promise((resolve) => {
    child.once("error", (err) => {
      cleanup();
      console.error(`Could not start ${claudeBin()}: ${err.message} (set CPR_CLAUDE_BIN to the claude executable)`);
      resolve(1);
    });
    child.once("exit", (code) => {
      cleanup();
      resolve(code ?? 0);
    });
  });
}

export async function runClaude(
  name: string,
  claudeArgs: string[],
  opts: { inference?: string; model?: string; share?: boolean } = {}
): Promise<number> {
  const dir = prepareAccountDir(name, { share: opts.share });
  const env = buildClaudeEnv(name, dir);

  if (!opts.inference || opts.inference === name) {
    const child = spawn(claudeBin(), claudeArgs, { stdio: "inherit", env });
    return forwardExit(child, () => undefined);
  }

  if (!isOauthProfile(readSettings(getProfileFilePath(name)))) {
    throw new Error(`Split mode needs ${name} to be a claude.ai login profile (that's what keeps Remote Control on).`);
  }
  const config = buildProxyConfig(opts.inference, { model: opts.model });
  const mitmdump = findMitmdump();
  if (!mitmdump) {
    throw new Error("Split mode needs mitmproxy: install it (pipx install mitmproxy) or set CPR_MITMDUMP.");
  }

  const work = path.join(getAccountsRoot(), ".proxy", String(process.pid));
  fs.mkdirSync(work, { recursive: true, mode: 0o700 });
  const configFile = path.join(work, "config.json");
  const addonFile = path.join(work, "addon.py");
  fs.writeFileSync(configFile, JSON.stringify(config), { mode: 0o600 });
  fs.writeFileSync(addonFile, PROXY_ADDON_PY);

  const confdir = path.join(os.homedir(), ".mitmproxy");
  const port = await freePort();
  const proxy = spawn(
    mitmdump,
    [
      "-q",
      "--listen-host", "127.0.0.1",
      "--listen-port", String(port),
      "--set", `confdir=${confdir}`,
      "--allow-hosts", "^api\\.anthropic\\.com(:443)?$",
      "-s", addonFile,
    ],
    { stdio: "ignore", env: { ...process.env, CPR_PROXY_CONFIG: configFile } }
  );

  const cleanup = (): void => {
    proxy.kill();
    fs.rmSync(work, { recursive: true, force: true });
  };

  const ready = await waitForPort(port, 15_000);
  const ca = path.join(confdir, "mitmproxy-ca-cert.pem");
  if (!ready || !fs.existsSync(ca)) {
    cleanup();
    throw new Error("mitmproxy did not start (or has no CA yet). Run mitmdump once, then retry.");
  }

  const proxyUrl = `http://127.0.0.1:${port}`;
  const child = spawn(claudeBin(), claudeArgs, {
    stdio: "inherit",
    env: { ...env, HTTPS_PROXY: proxyUrl, https_proxy: proxyUrl, NODE_EXTRA_CA_CERTS: ca },
  });
  return forwardExit(child, cleanup);
}
