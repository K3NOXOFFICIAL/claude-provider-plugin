import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApiKeyHelper } from "../src/utils.js";
import { writeProfile } from "../src/profiles.js";
import {
  buildClaudeEnv,
  buildProxyConfig,
  extractApiKey,
  getAccountDir,
  prepareAccountDir,
  runClaude,
} from "../src/runner.js";
import { PROXY_ADDON_PY } from "../src/proxy-addon.js";

let home: string;
const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "cpr-run-"));
  process.env.HOME = home;
  process.env.USERPROFILE = home;
});

afterEach(() => {
  process.env.HOME = saved.HOME;
  process.env.USERPROFILE = saved.USERPROFILE;
  fs.rmSync(home, { recursive: true, force: true });
});

describe("extractApiKey", () => {
  it("round-trips keys with quotes", () => {
    const key = "sk-a'b\"c";
    expect(extractApiKey({ apiKeyHelper: createApiKeyHelper(key), env: {} })).toBe(key);
    expect(extractApiKey({ env: { ANTHROPIC_AUTH_TOKEN: "t" } })).toBe("t");
  });
});

describe("prepareAccountDir", () => {
  it("creates an isolated dir with merged settings and no login", () => {
    fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
    fs.writeFileSync(
      path.join(home, ".claude", "settings.json"),
      JSON.stringify({ env: {}, permissions: { allow: ["Bash"] } })
    );
    fs.writeFileSync(
      path.join(home, ".claude.json"),
      JSON.stringify({ oauthAccount: { emailAddress: "a@x" }, mcpServers: { s: {} } })
    );
    writeProfile("acc-b", { env: {} });

    const dir = prepareAccountDir("acc-b");
    expect(dir).toBe(getAccountDir("acc-b"));
    const settings = JSON.parse(fs.readFileSync(path.join(dir, "settings.json"), "utf8"));
    expect(settings.permissions).toEqual({ allow: ["Bash"] });
    const json = JSON.parse(fs.readFileSync(path.join(dir, ".claude.json"), "utf8"));
    expect(json.oauthAccount).toBeUndefined();
    expect(json.mcpServers).toEqual({ s: {} });
    expect(buildClaudeEnv("acc-b", dir, { ANTHROPIC_BASE_URL: "https://x" }).ANTHROPIC_BASE_URL).toBeUndefined();
    expect(buildClaudeEnv("acc-b", dir, {}).CLAUDE_CONFIG_DIR).toBe(dir);
  });
});

describe("buildProxyConfig", () => {
  it("builds a gateway config from a /v1 profile", () => {
    writeProfile("gw", {
      apiKeyHelper: createApiKeyHelper("KEY"),
      env: {
        ANTHROPIC_BASE_URL: "https://gw.example.com:8443/sub",
        ANTHROPIC_DEFAULT_OPUS_MODEL: "big",
      },
    });
    expect(buildProxyConfig("gw")).toMatchObject({
      mode: "gateway",
      scheme: "https",
      host: "gw.example.com",
      port: 8443,
      basePath: "/sub",
      token: "KEY",
      tiers: { opus: "big" },
    });
  });

  it("points an OAuth profile at its own credentials file", () => {
    writeProfile("acc-b", { env: {} });
    if (process.platform === "darwin") return;
    expect(buildProxyConfig("acc-b")).toMatchObject({
      mode: "oauth",
      credentialsFile: path.join(getAccountDir("acc-b"), ".credentials.json"),
    });
  });

  it("rejects a profile with no endpoint", () => {
    writeProfile("bad", { apiKeyHelper: createApiKeyHelper("K"), env: {} });
    expect(() => buildProxyConfig("bad")).toThrow(/needs ANTHROPIC_BASE_URL/);
  });
});

describe("runClaude", () => {
  it("launches claude with the isolated config dir and no inherited gateway vars", async () => {
    writeProfile("acc-b", { env: {} });
    const out = path.join(home, "out.json");
    const script = path.join(home, "fake.js");
    fs.writeFileSync(
      script,
      `require("fs").writeFileSync(${JSON.stringify(out)}, JSON.stringify({dir: process.env.CLAUDE_CONFIG_DIR, base: process.env.ANTHROPIC_BASE_URL ?? null, args: process.argv.slice(2)}))`
    );
    process.env.CPR_CLAUDE_BIN = process.execPath;
    process.env.ANTHROPIC_BASE_URL = "https://leak.example";
    try {
      const code = await runClaude("acc-b", [script, "-p", "hi"]);
      expect(code).toBe(0);
    } finally {
      delete process.env.CPR_CLAUDE_BIN;
      delete process.env.ANTHROPIC_BASE_URL;
    }
    expect(JSON.parse(fs.readFileSync(out, "utf8"))).toEqual({
      dir: getAccountDir("acc-b"),
      base: null,
      args: ["-p", "hi"],
    });
  });

  it("refuses split mode when the session profile is not a claude.ai login", async () => {
    writeProfile("gw1", { apiKeyHelper: createApiKeyHelper("K"), env: { ANTHROPIC_BASE_URL: "https://a" } });
    writeProfile("gw2", { apiKeyHelper: createApiKeyHelper("K"), env: { ANTHROPIC_BASE_URL: "https://b" } });
    await expect(runClaude("gw1", [], { inference: "gw2" })).rejects.toThrow(/claude.ai login/);
  });
});

describe("proxy addon", () => {
  it("is valid Python", () => {
    const file = path.join(home, "addon.py");
    fs.writeFileSync(file, PROXY_ADDON_PY);
    const py = ["python", "python3", "py"].find((c) => spawnSync(c, ["--version"]).status === 0);
    if (!py) return;
    const res = spawnSync(py, ["-c", `import ast,sys;ast.parse(open(sys.argv[1],encoding="utf-8").read())`, file]);
    expect(res.status).toBe(0);
  });
});
