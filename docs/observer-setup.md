# Decision OS Observer Setup

## What it does

The observer sits at a LiteLLM proxy layer, watching LLM conversations as they pass through. It automatically detects when engineering pressure occurs -- moments where expectations diverge from reality, hidden constraints appear, or the approach has to change. When it detects these events, it calls Decision OS to record cases and pressure events without the main agent knowing.

## Prerequisites

- Node.js 18+
- Python 3.10+ (for LiteLLM)
- LiteLLM installed: `uv tool install 'litellm[proxy]'` or `pip install 'litellm[proxy]'`
- Decision OS repo built: `npm run build`

## Setup

### 1. Create the config directory

```bash
mkdir -p ~/.config/litellm
```

### 2. Create `~/.config/litellm/config.yaml`

LiteLLM supports two authentication modes. Choose the one that matches your setup.

#### Option A: Pass-through with Claude Code Max/Pro subscription (recommended)

This forwards Claude Code's OAuth token through to Anthropic, so you keep using your subscription plan. No API key is needed in the model config or the LiteLLM proxy. For a headless local setup, use a LiteLLM master key and send it separately via `x-litellm-api-key`, leaving `Authorization` available for Claude Code's subscription auth.

```yaml
model_list:
  - model_name: claude-opus-4-6
    litellm_params:
      model: anthropic/claude-opus-4-6
  - model_name: claude-sonnet-4-6
    litellm_params:
      model: anthropic/claude-sonnet-4-6
  - model_name: claude-haiku-4-5-20251001
    litellm_params:
      model: anthropic/claude-haiku-4-5-20251001

general_settings:
  master_key: os.environ/LITELLM_MASTER_KEY
  forward_client_headers_to_llm_api: true

litellm_settings:
  callbacks: ["decision_os_callback.decision_os_handler"]
```

The `forward_client_headers_to_llm_api: true` setting is what makes this work -- it passes the `Authorization` header (OAuth token) from Claude Code through LiteLLM to Anthropic's API. The `master_key` is only for LiteLLM's own auth layer; Claude Code should send it as `x-litellm-api-key`, not as `Authorization`.

> **Important:** Add every model that Claude Code might request. If a model isn't listed, LiteLLM will reject the request. Check LiteLLM logs for `Invalid model` errors if requests fail.

#### Option B: Direct API key authentication

If you don't have a Max/Pro subscription, you can use an Anthropic API key directly. Requests are billed per-token against your API account.

```yaml
model_list:
  - model_name: claude-opus-4-6
    litellm_params:
      model: anthropic/claude-opus-4-6
      api_key: os.environ/ANTHROPIC_API_KEY
  - model_name: claude-sonnet-4-6
    litellm_params:
      model: anthropic/claude-sonnet-4-6
  - model_name: claude-haiku-4-5-20251001
    litellm_params:
      model: anthropic/claude-haiku-4-5-20251001
      api_key: os.environ/ANTHROPIC_API_KEY

litellm_settings:
  callbacks: ["decision_os_callback.decision_os_handler"]
```

### 3. Copy the callback file

```bash
cp <decision-os-repo>/integrations/litellm/decision_os_callback.py ~/.config/litellm/
```

### 4. Create `~/.config/litellm/.env`

```
# Required for headless Claude Code -> LiteLLM auth
LITELLM_MASTER_KEY=sk-litellm-local

# Only needed for Option B (API key auth)
# ANTHROPIC_API_KEY=<your-key>

# Observer LLM detection (all 3 required, else heuristic fallback)
OBSERVER_MODEL=gpt-5.4
OBSERVER_API_KEY=<your-openai-key>
OBSERVER_BASE_URL=https://api.openai.com/v1

DECISION_OS_PATH=~/.decision-os              # Global fallback (NOT a project path)
DECISION_OS_REPO=<path-to-decision-os-repo>   # Where the Decision OS repo is cloned
```

> **Note:** `DECISION_OS_PATH` is the **global fallback** workspace — used only when the observer can't find a project-scoped `.decision-os/` directory from file paths in the conversation. Set it to `~/.decision-os`, not to a specific project. See [Workspace resolution](#workspace-resolution) for how the observer picks where to store data.

### 5. Create `~/.config/litellm/start.sh`

```bash
#!/bin/bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
LITELLM_BIN_PATH="${LITELLM_BIN_PATH:-$(command -v litellm)}"
LITELLM_PYTHON_BIN="${LITELLM_PYTHON_BIN:-$(sed -n '1s/^#!//p' "$LITELLM_BIN_PATH")}"
set -a
source "$SCRIPT_DIR/.env"
set +a
if [[ -z "${LITELLM_MASTER_KEY:-}" ]]; then
  echo "LITELLM_MASTER_KEY is required." >&2
  exit 1
fi
export PYTHONPATH="${DECISION_OS_REPO}:${PYTHONPATH:-}"
exec "$LITELLM_PYTHON_BIN" "<decision-os-repo>/integrations/litellm/litellm_proxy_entry.py" --config "$SCRIPT_DIR/config.yaml" --port 4000
```

The repo-local `litellm_proxy_entry.py` preserves the incoming `Authorization` header so Claude Code Max/Pro passthrough works with the current LiteLLM tool install.

Make it executable:

```bash
chmod +x ~/.config/litellm/start.sh
```

## Connecting Claude Code

### For Max/Pro subscriptions (Option A)

Add to `~/.claude/settings.json`:

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://localhost:4000",
    "ANTHROPIC_MODEL": "claude-opus-4-6",
    "ANTHROPIC_CUSTOM_HEADERS": "x-litellm-api-key: Bearer sk-litellm-local"
  }
}
```

Claude Code will authenticate to Anthropic via its normal OAuth flow, while authenticating to LiteLLM with `x-litellm-api-key`. The proxy forwards the Claude OAuth token upstream, preserving your subscription billing.

### For API key auth (Option B)

```bash
export ANTHROPIC_BASE_URL=http://localhost:4000
```

## Running

Start the proxy:

```bash
~/.config/litellm/start.sh
```

You should see:

```
LiteLLM: Proxy initialized with Config, Set models:
    claude-opus-4-6
    claude-sonnet-4-6
Uvicorn running on http://0.0.0.0:4000
```

All LLM traffic now flows through the observer. You'll see callback output in the proxy logs:

```
[Decision OS] Callback fired: session=..., msgs=25, response=yes
[Decision OS] Resolved workspace: /Users/you/Projects/foo
[Decision OS] ['TASK_START', 'PRESSURE_DETECTED'] -> [...]
```

## How detection works

The observer supports two detection modes:

- **LLM-powered detection** (when `OBSERVER_MODEL`, `OBSERVER_API_KEY`, and `OBSERVER_BASE_URL` are all set): A separate LLM classifies each conversation turn for process state changes. More accurate, costs a small amount per observed turn.
- **Heuristic fallback** (when any of those three env vars is missing): Pattern matching against known pressure signatures. Zero cost, good for testing.

Both modes detect three event types:

- `TASK_START` -- the agent begins a new unit of work
- `PRESSURE_DETECTED` -- reality diverged from expectation (assumption broke, hidden dependency, scope shift, tradeoff made)
- `COMPLETION_SIGNAL` -- the agent finishes the current task

## Switching providers

The observer uses the OpenAI SDK internally, so any OpenAI-compatible provider works as the detection backend. To switch, change the three env vars:

```
OBSERVER_MODEL=<model-name>
OBSERVER_API_KEY=<api-key>
OBSERVER_BASE_URL=<base-url>
```

## Troubleshooting

| Problem | Fix |
|---------|-----|
| `Invalid model name` error | Add the model to `model_list` in `config.yaml` and restart LiteLLM |
| `LITELLM_MASTER_KEY is not set` warning | Set `LITELLM_MASTER_KEY` in `.env` and send it from Claude Code via `ANTHROPIC_CUSTOM_HEADERS` |
| Callback not firing | Check that `decision_os_callback.py` is in `~/.config/litellm/` and `PYTHONPATH` includes `DECISION_OS_REPO` |
| OAuth errors with Max plan | Verify `forward_client_headers_to_llm_api: true` is set, `master_key` is configured, Claude Code sends `x-litellm-api-key`, and no provider `api_key` is in the model params |
| Pressure events in wrong project | The observer found `.decision-os/` in a different repo mentioned in the conversation. Check proxy logs for `Resolved workspace:`. See [Workspace resolution](#workspace-resolution) |
| Events going to global instead of project | The conversation didn't mention any file paths with a parent `.decision-os/` directory. Make sure the project has `.decision-os/` initialized |

## Where data lives

| Data | Location |
|------|----------|
| Observer sessions | `<workspace>/.decision-os/observer/sessions/<session-id>.json` |
| Cases and pressure events | `<workspace>/.decision-os/cases/` |

Observer session data is separate from core Decision OS data. You can delete the `observer/` directory without affecting case history.

### Workspace resolution

The observer needs to decide **which project** to write pressure events into. It does this automatically by scanning the conversation:

1. **Path scanning** — extracts absolute file paths from all messages and the LLM response (e.g., `/Users/you/Projects/foo/src/bar.py`)
2. **Walk up** — for each path, walks up the directory tree looking for a parent that contains `.decision-os/`
3. **Cache** — once a project root is found, it's cached for the entire session (all subsequent turns go to the same workspace)
4. **Global fallback** — if no `.decision-os/` is found in any mentioned path, falls back to `DECISION_OS_PATH` (which should be `~/.decision-os`, **not** a project path)

**Important:** The observer picks the first project whose `.decision-os/` it finds in the conversation. If you're working in a project that has its own `.decision-os/` directory, pressure events will land there — even if they aren't conceptually related to that project. This is a known limitation of path-based resolution.

#### Multi-project sessions

If your session touches files across multiple repos that each have `.decision-os/`, the **first match wins** and is locked for the session. There's no per-turn re-evaluation once a workspace is cached. Be aware of this when reviewing pressure events — they may need to be moved if they landed in the wrong project.
