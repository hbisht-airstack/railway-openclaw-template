import fs from "node:fs";
import path from "node:path";

const STATE_DIR = process.env.OPENCLAW_STATE_DIR || "/data/.openclaw";
const WORKSPACE_DIR = process.env.OPENCLAW_WORKSPACE_DIR || "/data/workspace";

// Config path — MCPORTER_CONFIG is set as a Railway env var so every process
// in the container (wrapper, gateway, agent, tools) can find it.
const MCPORTER_PATH =
  process.env.MCPORTER_CONFIG ||
  path.join(STATE_DIR, "config", "mcporter.json");

const IMAGE_SKILLS_DIR = "/opt/openclaw-skills";
const STATE_SKILLS_DIR = path.join(STATE_DIR, "skills");

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function exists(p) {
  try {
    fs.accessSync(p);
    return true;
  } catch {
    return false;
  }
}

// Recursive copy (Node 22 supports fs.cpSync)
function copyDirIfMissing(srcDir, dstDir) {
  if (!exists(srcDir)) return;
  if (exists(dstDir)) return;
  ensureDir(path.dirname(dstDir));
  fs.cpSync(srcDir, dstDir, { recursive: true });
}

function deepMerge(target, patch) {
  if (Array.isArray(target) || Array.isArray(patch)) return patch;
  if (typeof target !== "object" || target === null) return patch;
  if (typeof patch !== "object" || patch === null) return patch;

  const out = { ...target };
  for (const [k, v] of Object.entries(patch)) {
    out[k] = k in out ? deepMerge(out[k], v) : v;
  }
  return out;
}

function patchOpenClawJson() {
  const cfgPath = path.join(STATE_DIR, "openclaw.json");
  if (!exists(cfgPath)) return;

  const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));

  // Remove any invalid keys that would cause gateway startup to fail.
  delete cfg.mcpServers;

  const patch = {
    agents: {
      defaults: {
        workspace: WORKSPACE_DIR,
      },
    },
    channels: {
      telegram: { enabled: true },
    },
    plugins: {
      entries: {
        telegram: { enabled: true },
      },
    },
  };

  const merged = deepMerge(cfg, patch);
  fs.writeFileSync(cfgPath, JSON.stringify(merged, null, 2));
}

function writeMcporterConfig() {
  ensureDir(path.dirname(MCPORTER_PATH));

  const mcpUrl = process.env.SENPI_MCP_URL || "https://mcp.dev.senpi.ai/mcp";
  const senpiToken = process.env.SENPI_AUTH_TOKEN?.trim() || "";

  let config;
  if (exists(MCPORTER_PATH)) {
    // Smart merge: preserve any servers/settings the agent may have added
    try {
      config = JSON.parse(fs.readFileSync(MCPORTER_PATH, "utf8"));
      if (!config.mcpServers || typeof config.mcpServers !== "object") {
        config.mcpServers = {};
      }
    } catch {
      config = { mcpServers: {}, imports: [] };
    }
  } else {
    config = { mcpServers: {}, imports: [] };
  }

  const existingSenpi =
    config.mcpServers.senpi && typeof config.mcpServers.senpi === "object"
      ? config.mcpServers.senpi
      : {};
  const existingEnv =
    existingSenpi.env && typeof existingSenpi.env === "object"
      ? existingSenpi.env
      : {};
  const existingEnvToken =
    typeof existingEnv.SENPI_AUTH_TOKEN === "string"
      ? existingEnv.SENPI_AUTH_TOKEN.trim()
      : "";

  // Parse a previously persisted token from header args (if present).
  let existingHeaderToken = "";
  if (Array.isArray(existingSenpi.args)) {
    for (let i = 0; i < existingSenpi.args.length - 1; i += 1) {
      if (existingSenpi.args[i] !== "--header") continue;
      const header = existingSenpi.args[i + 1];
      if (typeof header !== "string") continue;
      const match = header.match(/^Authorization:\s*Bearer\s+(.+)$/i);
      if (match) {
        existingHeaderToken = match[1].trim();
        break;
      }
    }
  }

  // Token precedence:
  // 1) explicit env var from deployment
  // 2) existing token in mcporter env
  // 3) existing token in header args
  // 4) fallback to runtime expansion placeholder
  const effectiveToken = senpiToken || existingEnvToken || existingHeaderToken;
  const authHeader = effectiveToken
    ? `Authorization: Bearer ${effectiveToken}`
    : "Authorization: Bearer ${SENPI_AUTH_TOKEN}";

  const mergedEnv = { ...existingEnv };
  if (senpiToken) {
    mergedEnv.SENPI_AUTH_TOKEN = senpiToken;
  } else if (!mergedEnv.SENPI_AUTH_TOKEN && effectiveToken) {
    mergedEnv.SENPI_AUTH_TOKEN = effectiveToken;
  }

  // Upsert the senpi server while preserving unknown fields.
  config.mcpServers.senpi = {
    ...existingSenpi,
    command: "npx",
    args: ["mcp-remote", mcpUrl, "--header", authHeader],
    env: mergedEnv,
  };

  fs.writeFileSync(MCPORTER_PATH, JSON.stringify(config, null, 2));
}

export function bootstrapOpenClaw() {
  ensureDir(STATE_DIR);
  ensureDir(WORKSPACE_DIR);

  // Copy mcporter skill into persisted state (so OpenClaw loads it naturally)
  ensureDir(STATE_SKILLS_DIR);
  copyDirIfMissing(
    path.join(IMAGE_SKILLS_DIR, "mcporter"),
    path.join(STATE_SKILLS_DIR, "mcporter"),
  );

  writeMcporterConfig();
  patchOpenClawJson();
}
