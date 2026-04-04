#!/bin/bash
# Start LiteLLM proxy with Decision OS observer
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DEFAULT_CONFIG_PATH="$SCRIPT_DIR/config.yaml"
CONFIG_PATH="${1:-${LITELLM_CONFIG_PATH:-$DEFAULT_CONFIG_PATH}}"
LITELLM_BIN_PATH="${LITELLM_BIN_PATH:-$(command -v litellm)}"

if [[ ! "$CONFIG_PATH" = /* ]]; then
  CONFIG_PATH="$PWD/$CONFIG_PATH"
fi

if [[ ! -f "$CONFIG_PATH" ]]; then
  echo "LiteLLM config not found: $CONFIG_PATH" >&2
  exit 1
fi

if [[ -z "$LITELLM_BIN_PATH" || ! -x "$LITELLM_BIN_PATH" ]]; then
  echo "litellm executable not found on PATH" >&2
  exit 1
fi

if [[ -z "${LITELLM_PYTHON_BIN:-}" ]]; then
  LITELLM_PYTHON_BIN="$(sed -n '1s/^#!//p' "$LITELLM_BIN_PATH")"
fi

if [[ ! -x "$LITELLM_PYTHON_BIN" ]]; then
  echo "LiteLLM Python interpreter not found: $LITELLM_PYTHON_BIN" >&2
  exit 1
fi

# Load environment
if [[ ! -f "$SCRIPT_DIR/.env" ]]; then
  echo "ERROR: .env file not found at $SCRIPT_DIR/.env" >&2
  echo "" >&2
  echo "Create one from the example:" >&2
  echo "  cp $SCRIPT_DIR/env.example $SCRIPT_DIR/.env" >&2
  echo "" >&2
  echo "Then fill in your API keys (OBSERVER_API_KEY) and local paths." >&2
  exit 1
fi
set -a
source "$SCRIPT_DIR/.env"
set +a

if [[ -z "${LITELLM_MASTER_KEY:-}" ]]; then
  echo "LITELLM_MASTER_KEY is required for the headless Claude Code -> LiteLLM setup." >&2
  exit 1
fi

# Add Decision OS repo to PYTHONPATH so the callback module is importable
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
export DECISION_OS_REPO="${DECISION_OS_REPO:-$REPO_ROOT}"
export PYTHONPATH="${REPO_ROOT}:${PYTHONPATH:-}"

# Start the proxy
exec "$LITELLM_PYTHON_BIN" "$SCRIPT_DIR/litellm_proxy_entry.py" --config "$CONFIG_PATH" --port 4000
