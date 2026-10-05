# Tev1 local decision engine

Tev1 is an optional local fallback for ambiguous decisions in `chrome_act_toward_goal`. Clear and safe heuristic decisions run first. Tev1 is queried only when that heuristic cannot safely decide; unavailable, slow, invalid, or abstaining Tev1 results escalate to the MCP-calling agent. Safety checks remain authoritative.

## Shared MCP server configuration

The setting is read by the native MCP server at startup (not by generated `run_host` wrappers). Enable it in the environment of the process manager that launches the server, then restart that server:

- Windows user environment: `setx WEBCLAW_TEV1_ENABLED true`, then restart the MCP client/server so its new process inherits the setting.
- macOS/Linux service or shell: set `WEBCLAW_TEV1_ENABLED=true` in the MCP server's environment, then restart it.
- To disable, unset the variable or set it to any value other than `true`, then restart.

Configure the same environment for every MCP server instance where the shared behavior is desired. Do not put credentials or machine-specific paths in the MCP configuration. The server calls the local Ollama-compatible endpoint `http://127.0.0.1:11434/v1/systemone` with model `tev1:4b-q4_K_M`; install and serve that model locally before enabling. Requests have a 20-second timeout and at most 25 candidates. No cloud decision-model API key is used. Heuristic execution and caller escalation remain available when Tev1 is disabled or unavailable.
