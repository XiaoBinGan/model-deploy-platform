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


def powershell(script):
    return run(["powershell", "-NoProfile", "-NonInteractive", "-Command", script])


def to_gb(value):
    try:
        n = float(value)
    except (TypeError, ValueError):
        return None
    return round(n / 1024 ** 3, 1) if n > 0 else None


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
# platform.system() says "Windows", but every consumer of this profile spells it
# "win32", so normalize here instead of letting "windows" silently fail to match.
platform_name = {"Darwin": "darwin", "Windows": "win32", "Linux": "linux"}.get(system, "unknown")

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
elif system == "Windows":
    # /proc/meminfo does not exist here, which is why Windows reported
    # ram_gb=None forever. CIM is the portable way to read total memory.
    ram_gb = to_gb(powershell("(Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory"))
    if not gpus:
        # Win32_VideoController.AdapterRAM is a uint32 and truncates above 4GB
        # (a 12GB card reports 4GB). The display class key holds the real size
        # as a REG_QWORD, so read that instead. The separator is built with
        # chr(92) to keep this script free of escape sequences.
        bs = chr(92)
        key = bs.join(["HKLM:", "SYSTEM", "CurrentControlSet", "Control", "Class",
                       "{4d36e968-e325-11ce-bfc1-08002be10318}", "*"])
        script = ("Get-ItemProperty '" + key + "' -ErrorAction SilentlyContinue | "
                  "ForEach-Object { $_.DriverDesc + '|' + "
                  "$_.'HardwareInformation.qwMemorySize' }")
        for line in powershell(script).splitlines():
            name, _, size = line.strip().partition("|")
            if name:
                low = name.lower()
                gpus.append({
                    "name": name.strip(),
                    "vendor": "nvidia" if ("nvidia" in low or "geforce" in low or "rtx" in low) else "unknown",
                    "vram_gb": to_gb(size),
                    "uma": False,
                })
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
    "platform": platform_name,
    "architecture": platform.machine(),
    "cpu_cores": os.cpu_count(),
    "ram_gb": ram_gb,
    "gpus": gpus,
}))
'''


# Windows users usually have no Python, so the same profile is also offered as a
# PowerShell script. It reads the same sources and prints the same JSON shape.
PROBE_SCRIPT_PS1 = r'''# mdp-probe: print this machine hardware profile as JSON (read-only).
# Needs no Python: Windows machines usually do not have it.
$ErrorActionPreference = "SilentlyContinue"
$ProgressPreference = "SilentlyContinue"

$gpus = @()

# nvidia-smi is the most reliable source when present, but it is not always on
# PATH, so fall back to where the driver installer puts it.
$smi = $null
if (Get-Command nvidia-smi -ErrorAction SilentlyContinue) {
  $smi = "nvidia-smi"
} else {
  $candidate = Join-Path $env:ProgramFiles "NVIDIA Corporation\NVSMI\nvidia-smi.exe"
  if (Test-Path $candidate) { $smi = $candidate }
}
if ($smi) {
  foreach ($line in (& $smi --query-gpu=name,memory.total --format=csv,noheader,nounits)) {
    $parts = $line -split ","
    if ($parts.Count -ge 2) {
      $gpus += [pscustomobject]@{
        name    = $parts[0].Trim()
        vendor  = "nvidia"
        vram_gb = [math]::Round([double]$parts[1] / 1024, 1)
        uma     = $false
      }
    }
  }
}

$ramGb = $null
$cs = Get-CimInstance Win32_ComputerSystem
if ($cs -and $cs.TotalPhysicalMemory) {
  $ramGb = [math]::Round($cs.TotalPhysicalMemory / 1GB, 1)
}

if ($gpus.Count -eq 0) {
  # Win32_VideoController.AdapterRAM is a uint32 and truncates above 4GB, so a
  # 12GB card reports 4GB. The display class key stores the real size as a
  # REG_QWORD, so read that instead.
  $classKey = "HKLM:\SYSTEM\CurrentControlSet\Control\Class\{4d36e968-e325-11ce-bfc1-08002be10318}\*"
  foreach ($item in (Get-ItemProperty $classKey)) {
    if ($item.DriverDesc) {
      $bytes = $item.'HardwareInformation.qwMemorySize'
      $gb = $null
      if ($bytes -and $bytes -gt 0) { $gb = [math]::Round($bytes / 1GB, 1) }
      $vendor = "unknown"
      if ($item.DriverDesc -match "nvidia|geforce|rtx") { $vendor = "nvidia" }
      $gpus += [pscustomobject]@{ name = $item.DriverDesc; vendor = $vendor; vram_gb = $gb; uma = $false }
    }
  }
}

[pscustomobject]@{
  source       = "agent"
  platform     = "win32"
  architecture = $env:PROCESSOR_ARCHITECTURE
  cpu_cores    = [int]$env:NUMBER_OF_PROCESSORS
  ram_gb       = $ramGb
  gpus         = @($gpus)
} | ConvertTo-Json -Depth 5 -Compress
'''


def probe_script() -> str:
    return PROBE_SCRIPT


def probe_script_ps1() -> str:
    return PROBE_SCRIPT_PS1


def probe_command(base_url: str, platform_name: str = "") -> str:
    base = (base_url or "").rstrip("/")
    name = (platform_name or "").strip().lower()
    if name in ("win32", "windows"):
        # PowerShell needs no Python and no curl alias, both of which the
        # previous one-size-fits-all command assumed.
        return "irm " + base + "/api/hardware/probe.ps1 | iex"
    return "curl -fsSL " + base + "/api/hardware/probe.py | python3 -"
