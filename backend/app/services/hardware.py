"""Hardware budget probe.

Borrowed from Hermes-Agent's local_runtime/hardware.py:
the recommender is a pure function of a *measured* budget plus each
catalog entry's physical profile. Nothing here is a hand-maintained
"GPU -> model" table.

Two budgets exist on purpose:
  * planning budget  -> total capacity minus margin, used to price the catalog
  * live budget      -> currently free memory, used before an actual launch
If the catalog were priced with live memory, a machine that already has a
model loaded would mark every row as "does not fit".
"""
from dataclasses import dataclass, asdict
import platform
import subprocess

GIB = 1024 ** 3
MIB = 1024 ** 2

# Desktop compositor / Electron / runtime overhead observed in the wild.
DISCRETE_MARGIN_FLOOR = 2 * GIB
DISCRETE_MARGIN_RATIO = 0.09
# UMA devices lie about device memory (observed up to 3x), so budget from OS RAM.
UMA_HEADROOM_RATIO = 0.20


@dataclass
class HardwareBudget:
    usable_vram_bytes: int
    total_device_bytes: int
    ram_available_bytes: int
    uma: bool
    source: str
    device_name: str = ""

    @property
    def usable_vram_gb(self):
        return round(self.usable_vram_bytes / GIB, 2)

    @property
    def total_device_gb(self):
        return round(self.total_device_bytes / GIB, 2)

    @property
    def ram_available_gb(self):
        return round(self.ram_available_bytes / GIB, 2)

    def to_dict(self):
        d = asdict(self)
        d.update({
            "usable_vram_gb": self.usable_vram_gb,
            "total_device_gb": self.total_device_gb,
            "ram_available_gb": self.ram_available_gb,
        })
        return d


def _run(args):
    try:
        p = subprocess.run(args, capture_output=True, text=True, encoding="utf-8",
                           errors="replace", timeout=8)
        return p.stdout.strip() if p.returncode == 0 else ""
    except Exception:
        return ""


def _sysctl_int(name):
    try:
        return int(_run(["sysctl", "-n", name]))
    except (TypeError, ValueError):
        return 0


def _nvidia_devices():
    out = _run(["nvidia-smi", "--query-gpu=name,memory.total,memory.free",
                "--format=csv,noheader,nounits"])
    devices = []
    for line in out.splitlines():
        parts = [x.strip() for x in line.split(",")]
        if len(parts) >= 3:
            try:
                devices.append({
                    "name": parts[0],
                    "total": int(float(parts[1])) * MIB,
                    "free": int(float(parts[2])) * MIB,
                })
            except ValueError:
                continue
    return devices


def _os_ram():
    total = _sysctl_int("hw.memsize")
    if total:
        # macOS has no MemAvailable; approximate from free + inactive + speculative.
        page = _sysctl_int("hw.pagesize") or 4096
        vm = _run(["vm_stat"])
        free_pages = inactive_pages = speculative_pages = 0
        for line in vm.splitlines():
            if line.startswith("Pages free"):
                free_pages = _digits(line)
            elif line.startswith("Pages inactive"):
                inactive_pages = _digits(line)
            elif line.startswith("Pages speculative"):
                speculative_pages = _digits(line)
        available = (free_pages + inactive_pages + speculative_pages) * page
        if available <= 0:
            available = int(total * 0.5)
        return total, min(available, total)
    meminfo = {}
    try:
        with open("/proc/meminfo", "r", encoding="utf-8") as handle:
            for line in handle:
                key, _, rest = line.partition(":")
                meminfo[key.strip()] = rest.strip()
    except OSError:
        return 0, 0
    total = _kb(meminfo.get("MemTotal"))
    available = _kb(meminfo.get("MemAvailable")) or _kb(meminfo.get("MemFree"))
    return total, available or total


def _digits(line):
    digits = "".join(ch for ch in line if ch.isdigit())
    return int(digits) if digits else 0


def _kb(value):
    if not value:
        return 0
    try:
        return int(value.split()[0]) * 1024
    except (ValueError, IndexError):
        return 0


def probe_budget(planning=True):
    """Return a HardwareBudget for the current host.

    planning=True prices the catalog against total capacity minus margin.
    planning=False returns live free memory for a pre-launch fit check.
    """
    devices = _nvidia_devices()
    ram_total, ram_available = _os_ram()
    is_apple = platform.system() == "Darwin" and platform.machine() in {"arm64", "aarch64"}

    if devices:
        device = devices[0]
        total = device["total"]
        if planning:
            margin = max(DISCRETE_MARGIN_FLOOR, int(total * DISCRETE_MARGIN_RATIO))
            usable = max(0, total - margin)
        else:
            usable = device["free"]
        return HardwareBudget(usable, total, ram_available, False, "nvidia-smi", device["name"])

    if is_apple:
        total = ram_total or 0
        if planning:
            usable = int(total * (1 - UMA_HEADROOM_RATIO))
        else:
            usable = int(ram_available * (1 - UMA_HEADROOM_RATIO)) or int(total * 0.5)
        return HardwareBudget(usable, total, ram_available, True, "sysctl", "Apple Silicon GPU (Metal)")

    # No discrete GPU: fall back to treating system RAM as a unified pool.
    total = ram_total or 0
    usable = int(total * (1 - UMA_HEADROOM_RATIO)) if planning else int(ram_available * (1 - UMA_HEADROOM_RATIO))
    return HardwareBudget(usable, total, ram_available, True, "os-ram", platform.machine())
