"""
LiteLLM custom callback that feeds conversation data into the Decision OS observer.

Calls the Decision OS observer CLI (Node.js) via subprocess, passing
messages and response as JSON on stdin.

Setup in litellm config.yaml:
  litellm_settings:
    callbacks: integrations.litellm.decision_os_callback.decision_os_handler

Environment variables:
  DECISION_OS_PATH     - path to workspace containing .decision-os/
  DECISION_OS_BIN      - path to the observer CLI (default: dist/integrations/litellm/cli.js)
  DECISION_OS_NODE_BIN - path to node binary (default: node)

  LLM-powered detection (all three required, else falls back to heuristics):
  OBSERVER_MODEL       - model ID (e.g. "claude-sonnet-4-20250514")
  OBSERVER_API_KEY     - API key for the observer's LLM provider
  OBSERVER_BASE_URL    - base URL (e.g. "https://api.openai.com/v1")
"""

import json
import os
import subprocess
import sys
import uuid
import asyncio
from typing import Any, Optional

from litellm.integrations.custom_logger import CustomLogger


class DecisionOSCallback(CustomLogger):
    def __init__(self):
        self.workspace_path = os.environ.get("DECISION_OS_PATH", os.getcwd())
        repo_path = os.environ.get("DECISION_OS_REPO", os.path.dirname(__file__))
        self.cli_path = os.environ.get(
            "DECISION_OS_BIN",
            os.path.join(repo_path, "dist", "integrations", "litellm", "cli.js"),
        )
        self.node_bin = os.environ.get("DECISION_OS_NODE_BIN", "node")

        # Track turn offsets per session to ensure incremental processing
        self._turn_offsets: dict[str, int] = {}

    def _get_session_id(self, kwargs: dict) -> str:
        """Extract or generate a session ID from the request metadata."""
        metadata = kwargs.get("litellm_params", {}).get("metadata", {})

        # Try common metadata fields for session tracking
        for key in ("session_id", "trace_id", "request_id"):
            if key in metadata and metadata[key]:
                return str(metadata[key])

        # Fall back to a per-process session
        if not hasattr(self, "_fallback_session_id"):
            self._fallback_session_id = str(uuid.uuid4())
        return self._fallback_session_id

    def _extract_messages(self, kwargs: dict) -> list[dict]:
        """Extract input messages from kwargs."""
        messages = kwargs.get("messages", [])
        result = []
        for msg in messages:
            role = msg.get("role", "")
            content = msg.get("content", "")
            # Skip system messages and empty content
            if role == "system" or not content:
                continue
            # Handle content that's a list (multi-modal)
            if isinstance(content, list):
                text_parts = [p.get("text", "") for p in content if p.get("type") == "text"]
                content = " ".join(text_parts)
            if content:
                result.append({"role": role, "content": content})
        return result

    def _extract_response(self, response_obj: Any) -> Optional[dict]:
        """Extract response content from the response object."""
        try:
            choices = getattr(response_obj, "choices", None) or []
            if not choices:
                return None
            message = choices[0].message
            content = getattr(message, "content", None) or ""
            role = getattr(message, "role", "assistant")
            if not content:
                return None
            return {"role": role, "content": content}
        except (AttributeError, IndexError):
            return None

    async def async_log_success_event(
        self, kwargs: dict, response_obj: Any, start_time: Any, end_time: Any
    ):
        """Called by LiteLLM on successful completion. Feeds data to the observer."""
        try:
            session_id = self._get_session_id(kwargs)
            messages = self._extract_messages(kwargs)
            response = self._extract_response(response_obj)
            print(f"[Decision OS] Callback fired: session={session_id}, msgs={len(messages)}, response={'yes' if response else 'no'}", file=sys.stderr, flush=True)

            if not messages and not response:
                return

            turn_offset = self._turn_offsets.get(session_id, 0)

            cli_input = json.dumps({
                "session_id": session_id,
                "workspace_path": self.workspace_path,
                "messages": messages,
                "response": response or {"role": "assistant", "content": ""},
                "turn_offset": turn_offset,
            })

            # Update turn offset for next call
            turn_count = len(messages) + (1 if response else 0)
            self._turn_offsets[session_id] = turn_offset + turn_count

            # Run the observer CLI asynchronously
            proc = await asyncio.create_subprocess_exec(
                self.node_bin, self.cli_path,
                stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            stdout, stderr = await proc.communicate(input=cli_input.encode())

            if proc.returncode != 0:
                print(f"[Decision OS] Observer CLI error: {stderr.decode()}", file=sys.stderr, flush=True)
            elif stdout:
                result = json.loads(stdout.decode())
                if result.get("detected_events"):
                    print(f"[Decision OS] {result['detected_events']} -> {result.get('projections', [])}", file=sys.stderr, flush=True)

        except Exception as e:
            # Never let the callback crash the proxy
            print(f"[Decision OS] Callback error: {e}", file=sys.stderr, flush=True)


# Instance for LiteLLM to discover
decision_os_handler = DecisionOSCallback()
