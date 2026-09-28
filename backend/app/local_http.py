"""HTTP calls to services running on this machine.

httpx defaults to trust_env=True. On macOS that does more than read HTTP_PROXY:
urllib.request.getproxies() falls back to the *system* proxy settings, so a
proxy configured in System Settings is applied even when no proxy environment
variable exists. A request to 127.0.0.1 then leaves the machine and comes back
502.

That is not hypothetical. Measured on this host: `curl` to ollama returned 200
while httpx to the same URL returned 502, so _detect_backends() reported no
ollama and every ollama deployment was created as BLOCKED - with a working
ollama running. Exported via no_proxy/N O_PROXY only by luck.

Local runtimes must never go through a proxy. Every call in this module pins
trust_env=False; use it instead of httpx directly for anything on this host.
"""
from typing import Any

import httpx

# Applied to every call. A caller may override it, but should not need to.
_LOCAL: dict[str, Any] = {"trust_env": False}


def get(url: str, **kwargs: Any) -> httpx.Response:
    return httpx.get(url, **{**_LOCAL, **kwargs})


def post(url: str, **kwargs: Any) -> httpx.Response:
    return httpx.post(url, **{**_LOCAL, **kwargs})
