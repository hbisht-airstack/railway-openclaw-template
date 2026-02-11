import fs from "node:fs";
import path from "node:path";

const STATE_DIR = process.env.OPENCLAW_STATE_DIR || "/data/.openclaw";
const WORKSPACE_DIR = process.env.OPENCLAW_WORKSPACE_DIR || "/data/workspace";
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

function buildSenpiMcpServerEntry() {
  const mcpUrl = process.env.SENPI_MCP_URL || "https://mcp.dev.senpi.ai/mcp";
  const senpiToken = process.env.SENPI_AUTH_TOKEN?.trim() || "";
  if (!senpiToken) return null;

  return {
    command: "npx",
    args: [
      "mcp-remote",
      mcpUrl,
      "--header",
      `Authorization: Bearer ${senpiToken}`,
    ],
    env: {
      SENPI_AUTH_TOKEN: senpiToken,
    },
  };
}

function patchOpenClawJson() {
  const cfgPath = path.join(STATE_DIR, "openclaw.json");
  if (!exists(cfgPath)) return;

  const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));

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

  // Register Senpi MCP server directly in openclaw.json so the agent can use it.
  const senpiEntry = buildSenpiMcpServerEntry();
  if (senpiEntry) {
    patch.mcpServers = { senpi: senpiEntry };
  }

  const merged = deepMerge(cfg, patch);
  fs.writeFileSync(cfgPath, JSON.stringify(merged, null, 2));
}

function writeMcporterConfig() {
  ensureDir(path.dirname(MCPORTER_PATH));

  const mcpUrl = process.env.SENPI_MCP_URL || "https://mcp.dev.senpi.ai/mcp";
  const senpiToken = process.env.SENPI_AUTH_TOKEN?.trim() || "";

  const config = {
    mcpServers: {
      senpi: {
        command: "npx",
        args: [
          "mcp-remote",
          mcpUrl,
          "--header",
          "Authorization: Bearer ${SENPI_AUTH_TOKEN}",
        ],
        env: {
          SENPI_AUTH_TOKEN: senpiToken,
        },
      },
    },
    imports: [],
  };

  // Always write so SENPI_AUTH_TOKEN updates are picked up on redeploy.
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
