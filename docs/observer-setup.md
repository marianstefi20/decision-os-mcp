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

```yaml
model_list:
  - model_name: claude-sonnet-4-20250514
    litellm_params:
      model: anthropic/claude-sonnet-4-20250514
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
ANTHROPIC_API_KEY=<your-key>

# Observer LLM detection (all 3 required, else heuristic fallback)
OBSERVER_MODEL=claude-sonnet-4-20250514
OBSERVER_API_KEY=<your-key>
OBSERVER_BASE_URL=https://api.anthropic.com/v1

DECISION_OS_PATH=<path-to-your-project>
DECISION_OS_REPO=<path-to-decision-os-repo>
```

### 5. Create `~/.config/litellm/start.sh`

```bash
#!/bin/bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
set -a
source "$SCRIPT_DIR/.env"
set +a
export PYTHONPATH="${DECISION_OS_REPO}:${PYTHONPATH:-}"
exec litellm --config "$SCRIPT_DIR/config.yaml" --port 4000
```

Make it executable:

```bash
chmod +x ~/.config/litellm/start.sh
```

## Running

Start the proxy:

```bash
~/.config/litellm/start.sh
```

Then point your client at it:

```bash
export ANTHROPIC_BASE_URL=http://localhost:4000
```

All LLM traffic now flows through the observer.

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

## Where data lives

| Data | Location |
|------|----------|
| Observer sessions | `.decision-os/observer/sessions/<session-id>.json` |
| Cases and pressure events | `.decision-os/cases/` |

Observer session data is separate from core Decision OS data. You can delete the `observer/` directory without affecting case history.
