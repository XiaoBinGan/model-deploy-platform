"""Client hardware profiles: probe script, profile codes, paste parsing.

A profile code is a compact, self-verifying string a user can paste back after
running the probe on their own machine. It is base64url JSON with a version
prefix and a checksum, so a truncated or tampered code fails loudly instead of
silently producing a wrong budget.
"""
import base64
import hashlib
import json

VERSION = "mdp1"


def encode_profile(profile) -> str:
    raw = json.dumps(profile, separators=(",", ":"), sort_keys=True).encode("utf-8")
    digest = hashlib.sha256(raw).hexdigest()[:8]
    payload = base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")
    return VERSION + "." + payload + "." + digest


def decode_profile(code: str) -> dict:
    parts = (code or "").strip().split(".")
    if len(parts) != 3 or parts[0] != VERSION:
        raise ValueError("无效的档案码：应以 mdp1. 开头且包含三段")
    payload, digest = parts[1], parts[2]
    padded = payload + "=" * (-len(payload) % 4)
    try:
        raw = base64.urlsafe_b64decode(padded.encode("ascii"))
    except Exception as exc:
        raise ValueError("档案码不是合法的 base64url") from exc
    if hashlib.sha256(raw).hexdigest()[:8] != digest:
        raise ValueError("档案码校验和不匹配，可能被截断或修改")
    try:
        data = json.loads(raw.decode("utf-8"))
    except Exception as exc:
        raise ValueError("档案码内容不是合法 JSON") from exc
    if not isinstance(data, dict):
        raise ValueError("档案码内容必须是 JSON 对象")
    return data


def parse_profile_input(text: str) -> dict:
    """Accept either a profile code or a pasted JSON object."""
    text = (text or "").strip()
    if not text:
        raise ValueError("输入为空")
    if text.startswith("{"):
        try:
            data = json.loads(text)
        except Exception as exc:
            raise ValueError("粘贴的 JSON 无法解析") from exc
        if not isinstance(data, dict):
            raise ValueError("粘贴的内容必须是 JSON 对象")
        return data
    return decode_profile(text)


# Printed by the probe on the user's own machine. It only reads local state and
# prints JSON to stdout; it never talks to the network.
PROBE_SCRIPT = '''#!/usr/bin/env python3
"""mdp-probe: print this machine hardware profile as JSON (read-only)."""
import json
import os
import platform
import subprocess


def run(args):
    try:
        p = subprocess.run(args, capture_output=True, text=True, timeout=8)
        return p.stdout.strip() if p.returncode == 0 else ""
    except Exception:
        return ""


gpus = []
out = run(["nvidia-smi", "--query-gpu=name,memory.total", "--format=csv,noheader,nounits"])
for line in out.splitlines():
    parts = [x.strip() for x in line.split(",")]
    if len(parts) >= 2:
        try:
            gpus.append({
                "name": parts[0],
                "vendor": "nvidia",
                "vram_gb": round(float(parts[1]) / 1024, 1),
                "uma": False,
            })
        except ValueError:
            pass

system = platform.system()
ram_gb = None

if system == "Darwin":
    try:
        ram_gb = round(int(run(["sysctl", "-n", "hw.memsize"])) / 1024 ** 3, 1)
    except ValueError:
        pass
    if not gpus:
        name = "Apple GPU"
        for line in run(["system_profiler", "SPDisplaysDataType"]).splitlines():
            if "Chipset Model" in line:
                name = line.split(":", 1)[1].strip()
                break
        gpus.append({"name": name, "vendor": "apple", "vram_gb": None, "uma": True})
else:
    try:
        with open("/proc/meminfo") as fh:
            for line in fh:
                if line.startswith("MemTotal"):
                    ram_gb = round(int(line.split()[1]) / 1024 ** 2, 1)
                    break
    except OSError:
        pass

print(json.dumps({
    "source": "agent",
    "platform": system.lower(),
    "architecture": platform.machine(),
    "cpu_cores": os.cpu_count(),
    "ram_gb": ram_gb,
    "gpus": gpus,
}))
'''


def probe_script() -> str:
    return PROBE_SCRIPT


def probe_command(base_url: str, platform_name: str = "") -> str:
    base = (base_url or "").rstrip("/")
    return "curl -fsSL " + base + "/api/hardware/probe.py | python3 -"
