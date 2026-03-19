#!/usr/bin/env python3
"""
Repo-local LiteLLM launcher.

Work around LiteLLM 1.82.2 dropping Authorization headers even when
forward_client_headers_to_llm_api is enabled. Claude Code Max subscription
requests rely on that header reaching Anthropic unchanged.
"""

from __future__ import annotations

import sys
from typing import Union

from starlette.datastructures import Headers

from litellm import run_server
from litellm.proxy.litellm_pre_call_utils import LiteLLMProxyRequestSetup


def _patched_get_forwardable_headers(headers: Union[Headers, dict]) -> dict:
    forwarded_headers = {}
    saw_authorization = False
    saw_proxy_authorization = False
    saw_litellm_key = False
    for header, value in headers.items():
        header_lower = header.lower()
        if header_lower == "authorization":
            saw_authorization = True
            forwarded_headers[header] = value
        elif header_lower == "proxy-authorization":
            saw_proxy_authorization = True
        elif header_lower.startswith("x-") and not header_lower.startswith("x-stainless"):
            if header_lower == "x-litellm-api-key":
                saw_litellm_key = True
            forwarded_headers[header] = value
        elif header_lower.startswith("anthropic-beta"):
            forwarded_headers[header] = value

    print(
        "[LiteLLM auth-forward] "
        f"authorization={'yes' if saw_authorization else 'no'} "
        f"proxy_authorization={'yes' if saw_proxy_authorization else 'no'} "
        f"x_litellm_api_key={'yes' if saw_litellm_key else 'no'}",
        file=sys.stderr,
        flush=True,
    )

    return forwarded_headers


LiteLLMProxyRequestSetup._get_forwardable_headers = staticmethod(  # type: ignore[assignment]
    _patched_get_forwardable_headers
)


if __name__ == "__main__":
    raise SystemExit(run_server())
