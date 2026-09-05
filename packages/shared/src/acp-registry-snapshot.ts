// GENERATED FILE - DO NOT EDIT.
// Snapshot of Moonrend/acp-registry dist/index.json.
// Refresh with: pnpm acp:sync-registry
import type { AcpCuratedIndex } from "./acp-registry-client.js";

export const ACP_REGISTRY_SNAPSHOT = {
  "schemaVersion": 1,
  "imagePrefix": "ghcr.io/moonrend/acp-registry",
  "agents": [
    {
      "id": "agoragentic-acp",
      "name": "Agoragentic",
      "version": "1.3.0",
      "enabled": false,
      "profileId": "agoragentic-acp",
      "image": "ghcr.io/moonrend/acp-registry/agoragentic-acp:1.3.0",
      "dist": {
        "kind": "npx"
      },
      "storage": {
        "mode": "files",
        "env": {
          "HOME": "${RUNTIME_DIR}"
        },
        "artifacts": [
          {
            "durable": ".credentials.json",
            "runtime": ".credentials.json",
            "sync": "exit",
            "when": [
              "self"
            ]
          }
        ]
      },
      "auth": {
        "modes": [
          "self",
          "api_key"
        ]
      }
    },
    {
      "id": "amp-acp",
      "name": "Amp",
      "version": "0.9.0",
      "enabled": false,
      "profileId": "amp",
      "image": "ghcr.io/moonrend/acp-registry/amp-acp:0.9.0",
      "dist": {
        "kind": "binary"
      },
      "storage": {
        "mode": "files",
        "env": {
          "HOME": "${RUNTIME_DIR}"
        },
        "artifacts": [
          {
            "durable": ".credentials.json",
            "runtime": ".credentials.json",
            "sync": "exit",
            "when": [
              "self"
            ]
          }
        ]
      },
      "auth": {
        "modes": [
          "self",
          "api_key"
        ]
      }
    },
    {
      "id": "antigravity-acp",
      "name": "Google Antigravity",
      "version": "1.1.1",
      "enabled": false,
      "profileId": "antigravity-acp",
      "image": "ghcr.io/moonrend/acp-registry/antigravity-acp:1.1.1",
      "dist": {
        "kind": "binary"
      },
      "storage": {
        "mode": "files",
        "env": {
          "HOME": "${RUNTIME_DIR}"
        },
        "artifacts": [
          {
            "durable": ".credentials.json",
            "runtime": ".credentials.json",
            "sync": "exit",
            "when": [
              "self"
            ]
          }
        ]
      },
      "auth": {
        "modes": [
          "self",
          "api_key"
        ]
      }
    },
    {
      "id": "auggie",
      "name": "Auggie CLI",
      "version": "0.36.0",
      "enabled": false,
      "profileId": "auggie",
      "image": "ghcr.io/moonrend/acp-registry/auggie:0.36.0",
      "dist": {
        "kind": "npx"
      },
      "storage": {
        "mode": "files",
        "env": {
          "HOME": "${RUNTIME_DIR}"
        },
        "artifacts": [
          {
            "durable": ".credentials.json",
            "runtime": ".credentials.json",
            "sync": "exit",
            "when": [
              "self"
            ]
          }
        ]
      },
      "auth": {
        "modes": [
          "self",
          "api_key"
        ]
      }
    },
    {
      "id": "autohand",
      "name": "Autohand Code",
      "version": "0.2.1",
      "enabled": false,
      "profileId": "autohand",
      "image": "ghcr.io/moonrend/acp-registry/autohand:0.2.1",
      "dist": {
        "kind": "npx"
      },
      "storage": {
        "mode": "files",
        "env": {
          "HOME": "${RUNTIME_DIR}"
        },
        "artifacts": [
          {
            "durable": ".credentials.json",
            "runtime": ".credentials.json",
            "sync": "exit",
            "when": [
              "self"
            ]
          }
        ]
      },
      "auth": {
        "modes": [
          "self",
          "api_key"
        ]
      }
    },
    {
      "id": "claude-acp",
      "name": "Claude Agent",
      "version": "0.74.0",
      "enabled": true,
      "profileId": "claude-code",
      "image": "ghcr.io/moonrend/acp-registry/claude-acp:0.74.0",
      "dist": {
        "kind": "npx"
      },
      "storage": {
        "mode": "files",
        "env": {
          "HOME": "${RUNTIME_DIR}",
          "CLAUDE_CONFIG_DIR": "${STATE_DIR}"
        },
        "artifacts": [
          {
            "durable": ".claude/.credentials.json",
            "runtime": ".credentials.json",
            "sync": "exit",
            "when": [
              "self"
            ]
          },
          {
            "durable": ".claude/settings.json",
            "runtime": "settings.json",
            "sync": "exit",
            "when": [
              "self"
            ]
          },
          {
            "durable": ".claude/settings.local.json",
            "runtime": "settings.local.json",
            "sync": "exit",
            "when": [
              "self"
            ]
          },
          {
            "durable": ".claude/CLAUDE.md",
            "runtime": "CLAUDE.md",
            "sync": "exit",
            "when": [
              "self"
            ]
          },
          {
            "durable": ".claude.json",
            "runtime": ".claude.json",
            "sync": "none",
            "when": [
              "self"
            ]
          }
        ]
      },
      "auth": {
        "modes": [
          "self",
          "api_key"
        ]
      }
    },
    {
      "id": "cline",
      "name": "Cline",
      "version": "3.0.61",
      "enabled": false,
      "profileId": "cline",
      "image": "ghcr.io/moonrend/acp-registry/cline:3.0.61",
      "dist": {
        "kind": "npx"
      },
      "storage": {
        "mode": "files",
        "env": {
          "HOME": "${RUNTIME_DIR}"
        },
        "artifacts": [
          {
            "durable": ".credentials.json",
            "runtime": ".credentials.json",
            "sync": "exit",
            "when": [
              "self"
            ]
          }
        ]
      },
      "auth": {
        "modes": [
          "self",
          "api_key"
        ]
      }
    },
    {
      "id": "codebuddy-code",
      "name": "Codebuddy Code",
      "version": "2.144.0",
      "enabled": false,
      "profileId": "codebuddy",
      "image": "ghcr.io/moonrend/acp-registry/codebuddy-code:2.144.0",
      "dist": {
        "kind": "npx"
      },
      "storage": {
        "mode": "files",
        "env": {
          "HOME": "${RUNTIME_DIR}"
        },
        "artifacts": [
          {
            "durable": ".credentials.json",
            "runtime": ".credentials.json",
            "sync": "exit",
            "when": [
              "self"
            ]
          }
        ]
      },
      "auth": {
        "modes": [
          "self",
          "api_key"
        ]
      }
    },
    {
      "id": "codex-acp",
      "name": "Codex",
      "version": "1.10.0",
      "enabled": false,
      "profileId": "codex",
      "image": "ghcr.io/moonrend/acp-registry/codex-acp:1.10.0",
      "dist": {
        "kind": "npx"
      },
      "storage": {
        "mode": "files",
        "env": {
          "HOME": "${RUNTIME_DIR}",
          "CODEX_HOME": "${STATE_DIR}",
          "CODEX_SQLITE_HOME": "${STATE_DIR}"
        },
        "artifacts": [
          {
            "durable": ".codex/auth.json",
            "runtime": "auth.json",
            "sync": "codex_auth",
            "when": [
              "self",
              "oauth"
            ]
          },
          {
            "durable": ".codex/auth.json",
            "runtime": "auth.json",
            "sync": "none",
            "when": [
              "api_key"
            ]
          },
          {
            "durable": ".codex/config.toml",
            "runtime": "config.toml",
            "sync": "exit",
            "when": [
              "self"
            ]
          },
          {
            "durable": ".codex/config.toml",
            "runtime": "config.toml",
            "sync": "none",
            "when": [
              "oauth",
              "api_key"
            ]
          }
        ]
      },
      "auth": {
        "modes": [
          "self",
          "oauth",
          "api_key"
        ],
        "apiKeyEnv": [
          "OPENAI_API_KEY"
        ],
        "noBrowserEnv": {
          "NO_BROWSER": "1"
        }
      }
    },
    {
      "id": "cortex-code",
      "name": "Cortex Code",
      "version": "1.0.73",
      "enabled": false,
      "profileId": "cortex-code",
      "image": "ghcr.io/moonrend/acp-registry/cortex-code:1.0.73",
      "dist": {
        "kind": "binary"
      },
      "storage": {
        "mode": "files",
        "env": {
          "HOME": "${RUNTIME_DIR}"
        },
        "artifacts": [
          {
            "durable": ".credentials.json",
            "runtime": ".credentials.json",
            "sync": "exit",
            "when": [
              "self"
            ]
          }
        ]
      },
      "auth": {
        "modes": [
          "self",
          "api_key"
        ]
      }
    },
    {
      "id": "corust-agent",
      "name": "Corust Agent",
      "version": "0.6.0",
      "enabled": false,
      "profileId": "corust-agent",
      "image": "ghcr.io/moonrend/acp-registry/corust-agent:0.6.0",
      "dist": {
        "kind": "binary"
      },
      "storage": {
        "mode": "files",
        "env": {
          "HOME": "${RUNTIME_DIR}"
        },
        "artifacts": [
          {
            "durable": ".credentials.json",
            "runtime": ".credentials.json",
            "sync": "exit",
            "when": [
              "self"
            ]
          }
        ]
      },
      "auth": {
        "modes": [
          "self",
          "api_key"
        ]
      }
    },
    {
      "id": "crow-cli",
      "name": "crow-cli",
      "version": "0.1.24",
      "enabled": false,
      "profileId": "crow-cli",
      "image": "ghcr.io/moonrend/acp-registry/crow-cli:0.1.24",
      "dist": {
        "kind": "binary"
      },
      "storage": {
        "mode": "files",
        "env": {
          "HOME": "${RUNTIME_DIR}"
        },
        "artifacts": [
          {
            "durable": ".credentials.json",
            "runtime": ".credentials.json",
            "sync": "exit",
            "when": [
              "self"
            ]
          }
        ]
      },
      "auth": {
        "modes": [
          "self",
          "api_key"
        ]
      }
    },
    {
      "id": "cursor",
      "name": "Cursor",
      "version": "2026.09.02",
      "enabled": false,
      "profileId": "cursor",
      "image": "ghcr.io/moonrend/acp-registry/cursor:2026.09.02",
      "dist": {
        "kind": "binary"
      },
      "storage": {
        "mode": "files",
        "env": {
          "HOME": "${RUNTIME_DIR}"
        },
        "artifacts": [
          {
            "durable": ".credentials.json",
            "runtime": ".credentials.json",
            "sync": "exit",
            "when": [
              "self"
            ]
          }
        ]
      },
      "auth": {
        "modes": [
          "self",
          "api_key"
        ]
      }
    },
    {
      "id": "deepagents",
      "name": "DeepAgents",
      "version": "0.1.7",
      "enabled": false,
      "profileId": "deepagents",
      "image": "ghcr.io/moonrend/acp-registry/deepagents:0.1.7",
      "dist": {
        "kind": "npx"
      },
      "storage": {
        "mode": "files",
        "env": {
          "HOME": "${RUNTIME_DIR}"
        },
        "artifacts": [
          {
            "durable": ".credentials.json",
            "runtime": ".credentials.json",
            "sync": "exit",
            "when": [
              "self"
            ]
          }
        ]
      },
      "auth": {
        "modes": [
          "self",
          "api_key"
        ]
      }
    },
    {
      "id": "devin",
      "name": "Devin",
      "version": "3000.6.14",
      "enabled": false,
      "profileId": "devin",
      "image": "ghcr.io/moonrend/acp-registry/devin:3000.6.14",
      "dist": {
        "kind": "binary"
      },
      "storage": {
        "mode": "files",
        "env": {
          "HOME": "${RUNTIME_DIR}"
        },
        "artifacts": [
          {
            "durable": ".credentials.json",
            "runtime": ".credentials.json",
            "sync": "exit",
            "when": [
              "self"
            ]
          }
        ]
      },
      "auth": {
        "modes": [
          "self",
          "api_key"
        ]
      }
    },
    {
      "id": "dimcode",
      "name": "DimCode",
      "version": "0.3.28",
      "enabled": false,
      "profileId": "dimcode",
      "image": "ghcr.io/moonrend/acp-registry/dimcode:0.3.28",
      "dist": {
        "kind": "npx"
      },
      "storage": {
        "mode": "files",
        "env": {
          "HOME": "${RUNTIME_DIR}"
        },
        "artifacts": [
          {
            "durable": ".credentials.json",
            "runtime": ".credentials.json",
            "sync": "exit",
            "when": [
              "self"
            ]
          }
        ]
      },
      "auth": {
        "modes": [
          "self",
          "api_key"
        ]
      }
    },
    {
      "id": "dirac",
      "name": "Dirac",
      "version": "0.5.9",
      "enabled": false,
      "profileId": "dirac",
      "image": "ghcr.io/moonrend/acp-registry/dirac:0.5.9",
      "dist": {
        "kind": "npx"
      },
      "storage": {
        "mode": "files",
        "env": {
          "HOME": "${RUNTIME_DIR}"
        },
        "artifacts": [
          {
            "durable": ".credentials.json",
            "runtime": ".credentials.json",
            "sync": "exit",
            "when": [
              "self"
            ]
          }
        ]
      },
      "auth": {
        "modes": [
          "self",
          "api_key"
        ]
      }
    },
    {
      "id": "factory-droid",
      "name": "Factory Droid",
      "version": "0.212.1",
      "enabled": false,
      "profileId": "factory-droid",
      "image": "ghcr.io/moonrend/acp-registry/factory-droid:0.212.1",
      "dist": {
        "kind": "npx"
      },
      "storage": {
        "mode": "files",
        "env": {
          "HOME": "${RUNTIME_DIR}"
        },
        "artifacts": [
          {
            "durable": ".credentials.json",
            "runtime": ".credentials.json",
            "sync": "exit",
            "when": [
              "self"
            ]
          }
        ]
      },
      "auth": {
        "modes": [
          "self",
          "api_key"
        ]
      }
    },
    {
      "id": "fast-agent",
      "name": "fast-agent",
      "version": "0.10.1",
      "enabled": false,
      "profileId": "fast-agent",
      "image": "ghcr.io/moonrend/acp-registry/fast-agent:0.10.1",
      "dist": {
        "kind": "uvx"
      },
      "storage": {
        "mode": "files",
        "env": {
          "HOME": "${RUNTIME_DIR}"
        },
        "artifacts": [
          {
            "durable": ".credentials.json",
            "runtime": ".credentials.json",
            "sync": "exit",
            "when": [
              "self"
            ]
          }
        ]
      },
      "auth": {
        "modes": [
          "self",
          "api_key"
        ]
      }
    },
    {
      "id": "gemini",
      "name": "Gemini CLI",
      "version": "0.58.0",
      "enabled": true,
      "profileId": "gemini-cli",
      "image": "ghcr.io/moonrend/acp-registry/gemini:0.58.0",
      "dist": {
        "kind": "npx"
      },
      "storage": {
        "mode": "files",
        "env": {
          "HOME": "${RUNTIME_DIR}"
        },
        "artifacts": [
          {
            "durable": ".credentials.json",
            "runtime": ".credentials.json",
            "sync": "exit",
            "when": [
              "self"
            ]
          }
        ]
      },
      "auth": {
        "modes": [
          "self",
          "api_key"
        ]
      }
    },
    {
      "id": "github-copilot-cli",
      "name": "GitHub Copilot",
      "version": "1.0.83",
      "enabled": false,
      "profileId": "copilot",
      "image": "ghcr.io/moonrend/acp-registry/github-copilot-cli:1.0.83",
      "dist": {
        "kind": "npx"
      },
      "storage": {
        "mode": "state-home",
        "xdg": true,
        "artifacts": [
          {
            "durable": "home",
            "runtime": "home",
            "sync": "exit",
            "when": [
              "self",
              "oauth"
            ]
          }
        ]
      },
      "auth": {
        "modes": [
          "self",
          "api_key"
        ]
      }
    },
    {
      "id": "glm-acp-agent",
      "name": "GLM Agent",
      "version": "1.8.0",
      "enabled": false,
      "profileId": "glm-acp-agent",
      "image": "ghcr.io/moonrend/acp-registry/glm-acp-agent:1.8.0",
      "dist": {
        "kind": "npx"
      },
      "storage": {
        "mode": "files",
        "env": {
          "HOME": "${RUNTIME_DIR}"
        },
        "artifacts": [
          {
            "durable": ".credentials.json",
            "runtime": ".credentials.json",
            "sync": "exit",
            "when": [
              "self"
            ]
          }
        ]
      },
      "auth": {
        "modes": [
          "self",
          "api_key"
        ]
      }
    },
    {
      "id": "goose",
      "name": "goose",
      "version": "1.49.0",
      "enabled": true,
      "profileId": "goose",
      "image": "ghcr.io/moonrend/acp-registry/goose:1.49.0",
      "dist": {
        "kind": "binary"
      },
      "storage": {
        "mode": "files",
        "env": {
          "HOME": "${RUNTIME_DIR}"
        },
        "artifacts": [
          {
            "durable": ".credentials.json",
            "runtime": ".credentials.json",
            "sync": "exit",
            "when": [
              "self"
            ]
          }
        ]
      },
      "auth": {
        "modes": [
          "self",
          "api_key"
        ]
      }
    },
    {
      "id": "grok-build",
      "name": "Grok Build",
      "version": "1.0.21",
      "enabled": false,
      "profileId": "grok",
      "image": "ghcr.io/moonrend/acp-registry/grok-build:1.0.21",
      "dist": {
        "kind": "npx"
      },
      "storage": {
        "mode": "state-home",
        "xdg": true,
        "artifacts": [
          {
            "durable": "home",
            "runtime": "home",
            "sync": "exit",
            "when": [
              "self",
              "oauth"
            ]
          }
        ]
      },
      "auth": {
        "modes": [
          "self",
          "api_key"
        ]
      }
    },
    {
      "id": "harn",
      "name": "Harn",
      "version": "0.10.129",
      "enabled": false,
      "profileId": "harn",
      "image": "ghcr.io/moonrend/acp-registry/harn:0.10.129",
      "dist": {
        "kind": "binary"
      },
      "storage": {
        "mode": "files",
        "env": {
          "HOME": "${RUNTIME_DIR}"
        },
        "artifacts": [
          {
            "durable": ".credentials.json",
            "runtime": ".credentials.json",
            "sync": "exit",
            "when": [
              "self"
            ]
          }
        ]
      },
      "auth": {
        "modes": [
          "self",
          "api_key"
        ]
      }
    },
    {
      "id": "junie",
      "name": "Junie",
      "version": "3123.7.0",
      "enabled": false,
      "profileId": "junie",
      "image": "ghcr.io/moonrend/acp-registry/junie:3123.7.0",
      "dist": {
        "kind": "binary"
      },
      "storage": {
        "mode": "files",
        "env": {
          "HOME": "${RUNTIME_DIR}"
        },
        "artifacts": [
          {
            "durable": ".credentials.json",
            "runtime": ".credentials.json",
            "sync": "exit",
            "when": [
              "self"
            ]
          }
        ]
      },
      "auth": {
        "modes": [
          "self",
          "api_key"
        ]
      }
    },
    {
      "id": "kilo",
      "name": "Kilo",
      "version": "7.5.14",
      "enabled": false,
      "profileId": "kilo",
      "image": "ghcr.io/moonrend/acp-registry/kilo:7.5.14",
      "dist": {
        "kind": "npx"
      },
      "storage": {
        "mode": "files",
        "env": {
          "HOME": "${RUNTIME_DIR}"
        },
        "artifacts": [
          {
            "durable": ".credentials.json",
            "runtime": ".credentials.json",
            "sync": "exit",
            "when": [
              "self"
            ]
          }
        ]
      },
      "auth": {
        "modes": [
          "self",
          "api_key"
        ]
      }
    },
    {
      "id": "kimi",
      "name": "Kimi CLI",
      "version": "1.50.0",
      "enabled": false,
      "profileId": "kimi-code",
      "image": "ghcr.io/moonrend/acp-registry/kimi:1.50.0",
      "dist": {
        "kind": "binary"
      },
      "storage": {
        "mode": "state-home",
        "xdg": true,
        "artifacts": [
          {
            "durable": "home",
            "runtime": "home",
            "sync": "exit",
            "when": [
              "self",
              "oauth"
            ]
          }
        ]
      },
      "auth": {
        "modes": [
          "self",
          "api_key"
        ]
      }
    },
    {
      "id": "minion-code",
      "name": "Minion Code",
      "version": "0.1.44",
      "enabled": false,
      "profileId": "minion-code",
      "image": "ghcr.io/moonrend/acp-registry/minion-code:0.1.44",
      "dist": {
        "kind": "uvx"
      },
      "storage": {
        "mode": "files",
        "env": {
          "HOME": "${RUNTIME_DIR}"
        },
        "artifacts": [
          {
            "durable": ".credentials.json",
            "runtime": ".credentials.json",
            "sync": "exit",
            "when": [
              "self"
            ]
          }
        ]
      },
      "auth": {
        "modes": [
          "self",
          "api_key"
        ]
      }
    },
    {
      "id": "mistral-vibe",
      "name": "Mistral Vibe",
      "version": "2.24.1",
      "enabled": false,
      "profileId": "mistral-vibe",
      "image": "ghcr.io/moonrend/acp-registry/mistral-vibe:2.24.1",
      "dist": {
        "kind": "binary"
      },
      "storage": {
        "mode": "files",
        "env": {
          "HOME": "${RUNTIME_DIR}"
        },
        "artifacts": [
          {
            "durable": ".credentials.json",
            "runtime": ".credentials.json",
            "sync": "exit",
            "when": [
              "self"
            ]
          }
        ]
      },
      "auth": {
        "modes": [
          "self",
          "api_key"
        ]
      }
    },
    {
      "id": "nova",
      "name": "Nova",
      "version": "1.1.37",
      "enabled": false,
      "profileId": "nova",
      "image": "ghcr.io/moonrend/acp-registry/nova:1.1.37",
      "dist": {
        "kind": "npx"
      },
      "storage": {
        "mode": "files",
        "env": {
          "HOME": "${RUNTIME_DIR}"
        },
        "artifacts": [
          {
            "durable": ".credentials.json",
            "runtime": ".credentials.json",
            "sync": "exit",
            "when": [
              "self"
            ]
          }
        ]
      },
      "auth": {
        "modes": [
          "self",
          "api_key"
        ]
      }
    },
    {
      "id": "opencode",
      "name": "OpenCode",
      "version": "1.18.29",
      "enabled": true,
      "profileId": "opencode",
      "image": "ghcr.io/moonrend/acp-registry/opencode:1.18.29",
      "dist": {
        "kind": "binary"
      },
      "storage": {
        "mode": "state-home",
        "xdg": true,
        "artifacts": [
          {
            "durable": "home",
            "runtime": "home",
            "sync": "exit",
            "when": [
              "self",
              "oauth"
            ]
          },
          {
            "durable": "home",
            "runtime": "home",
            "sync": "none",
            "when": [
              "api_key"
            ]
          }
        ]
      },
      "auth": {
        "modes": [
          "self",
          "api_key"
        ]
      }
    },
    {
      "id": "pi-acp",
      "name": "pi ACP",
      "version": "0.0.33",
      "enabled": false,
      "profileId": "pi",
      "image": "ghcr.io/moonrend/acp-registry/pi-acp:0.0.33",
      "dist": {
        "kind": "npx"
      },
      "storage": {
        "mode": "state-home",
        "xdg": true,
        "artifacts": [
          {
            "durable": "home",
            "runtime": "home",
            "sync": "exit",
            "when": [
              "self",
              "oauth"
            ]
          }
        ]
      },
      "auth": {
        "modes": [
          "self",
          "api_key"
        ]
      }
    },
    {
      "id": "poolside",
      "name": "Poolside",
      "version": "1.0.16",
      "enabled": false,
      "profileId": "poolside",
      "image": "ghcr.io/moonrend/acp-registry/poolside:1.0.16",
      "dist": {
        "kind": "binary"
      },
      "storage": {
        "mode": "files",
        "env": {
          "HOME": "${RUNTIME_DIR}"
        },
        "artifacts": [
          {
            "durable": ".credentials.json",
            "runtime": ".credentials.json",
            "sync": "exit",
            "when": [
              "self"
            ]
          }
        ]
      },
      "auth": {
        "modes": [
          "self",
          "api_key"
        ]
      }
    },
    {
      "id": "qoder",
      "name": "Qoder CLI",
      "version": "0.2.14",
      "enabled": false,
      "profileId": "qoder",
      "image": "ghcr.io/moonrend/acp-registry/qoder:0.2.14",
      "dist": {
        "kind": "npx"
      },
      "storage": {
        "mode": "files",
        "env": {
          "HOME": "${RUNTIME_DIR}"
        },
        "artifacts": [
          {
            "durable": ".credentials.json",
            "runtime": ".credentials.json",
            "sync": "exit",
            "when": [
              "self"
            ]
          }
        ]
      },
      "auth": {
        "modes": [
          "self",
          "api_key"
        ]
      }
    },
    {
      "id": "qwen-code",
      "name": "Qwen Code",
      "version": "0.23.0",
      "enabled": true,
      "profileId": "qwen-code",
      "image": "ghcr.io/moonrend/acp-registry/qwen-code:0.23.0",
      "dist": {
        "kind": "npx"
      },
      "storage": {
        "mode": "files",
        "env": {
          "HOME": "${RUNTIME_DIR}"
        },
        "artifacts": [
          {
            "durable": ".credentials.json",
            "runtime": ".credentials.json",
            "sync": "exit",
            "when": [
              "self"
            ]
          }
        ]
      },
      "auth": {
        "modes": [
          "self",
          "api_key"
        ]
      }
    },
    {
      "id": "sigit",
      "name": "siGit Code",
      "version": "1.5.2",
      "enabled": false,
      "profileId": "sigit",
      "image": "ghcr.io/moonrend/acp-registry/sigit:1.5.2",
      "dist": {
        "kind": "npx"
      },
      "storage": {
        "mode": "files",
        "env": {
          "HOME": "${RUNTIME_DIR}"
        },
        "artifacts": [
          {
            "durable": ".credentials.json",
            "runtime": ".credentials.json",
            "sync": "exit",
            "when": [
              "self"
            ]
          }
        ]
      },
      "auth": {
        "modes": [
          "self",
          "api_key"
        ]
      }
    },
    {
      "id": "stakpak",
      "name": "Stakpak",
      "version": "0.3.88",
      "enabled": false,
      "profileId": "stakpak",
      "image": "ghcr.io/moonrend/acp-registry/stakpak:0.3.88",
      "dist": {
        "kind": "binary"
      },
      "storage": {
        "mode": "files",
        "env": {
          "HOME": "${RUNTIME_DIR}"
        },
        "artifacts": [
          {
            "durable": ".credentials.json",
            "runtime": ".credentials.json",
            "sync": "exit",
            "when": [
              "self"
            ]
          }
        ]
      },
      "auth": {
        "modes": [
          "self",
          "api_key"
        ]
      }
    },
    {
      "id": "vtcode",
      "name": "VT Code",
      "version": "0.96.14",
      "enabled": false,
      "profileId": "vtcode",
      "image": "ghcr.io/moonrend/acp-registry/vtcode:0.96.14",
      "dist": {
        "kind": "binary"
      },
      "storage": {
        "mode": "files",
        "env": {
          "HOME": "${RUNTIME_DIR}"
        },
        "artifacts": [
          {
            "durable": ".credentials.json",
            "runtime": ".credentials.json",
            "sync": "exit",
            "when": [
              "self"
            ]
          }
        ]
      },
      "auth": {
        "modes": [
          "self",
          "api_key"
        ]
      }
    }
  ],
  "digest": "24275e1e08b370cd"
} as AcpCuratedIndex;
