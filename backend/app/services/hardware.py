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

from . import gpu_table

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
    # Total system RAM. Not a planning input: it is the physical ceiling a
    # spilling model can reach when free memory is unknown (a client profile),
    # so physics_check can tell "does not fit VRAM" from "does not fit at all".
    ram_total_bytes: int = 0

    @property
    def usable_vram_gb(self):
        return round(self.usable_vram_bytes / GIB, 2)

    @property
    def total_device_gb(self):
        return round(self.total_device_bytes / GIB, 2)

    @property
    def ram_available_gb(self):
        return round(self.ram_available_bytes / GIB, 2)

    @property
    def ram_total_gb(self):
        return round(self.ram_total_bytes / GIB, 2)

    def to_dict(self):
        d = asdict(self)
        d.update({
            "usable_vram_gb": self.usable_vram_gb,
            "total_device_gb": self.total_device_gb,
            "ram_available_gb": self.ram_available_gb,
            "ram_total_gb": self.ram_total_gb,
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


# --- client-submitted profiles ---------------------------------------------
# A profile arrives from an untrusted browser. It is validated and clamped, and
# it is never treated as a measurement.

VRAM_MIN_GB, VRAM_MAX_GB = 0.5, 4096.0
RAM_MIN_GB, RAM_MAX_GB = 0.5, 4096.0
CORES_MIN, CORES_MAX = 1, 1024
MAX_GPUS = 4


def _clamp(value, low, high):
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    if number != number or number in (float("inf"), float("-inf")):
        return None
    return max(low, min(high, number))


def _clean_text(value, limit=200):
    if value is None:
        return ""
    return str(value)[:limit]


# windows-gaps.md D: one enum, one normalization point. The probe used to emit
# "windows" while the UI spoke "win32", so a Windows profile silently failed to
# match every platform check.
PLATFORM_VALUES = ("darwin", "win32", "linux", "unknown")


def normalize_platform(value):
    """Normalize any platform spelling to darwin / win32 / linux / unknown."""
    name = _clean_text(value, 32).strip().lower()
    if name in {"darwin", "macos", "mac", "macosx", "osx", "mac os x"}:
        return "darwin"
    if name in {"win32", "windows", "win"}:
        return "win32"
    if name in {"linux", "gnu/linux"}:
        return "linux"
    return "unknown"


def _table_vram(name):
    """VRAM the GPU lookup table claims for a name, or None on a miss."""
    if not name:
        return None
    try:
        return gpu_table.lookup(name).get("vram_gb")
    except Exception:
        return None


# Cross-validation verdicts (docs/probe-session-design.md section 6). Frozen
# contract: the frontend keys its labels off these exact strings.
CONFIDENCE_VALUES = ("verified", "measured", "disputed", "unverified", "confirmed")
# "measured matches the table" is +/- 0.5 GB; anything wider is a disagreement.
CONFIDENCE_TOLERANCE_GB = 0.5


def _cross_validate(profile, measured, warnings):
    """Compare measured VRAM against the lookup table.

    measured is [(name, vram_gb)] for values the profile actually claimed. A
    browser cannot read VRAM, so its values are table values, not measurements.
    """
    if profile.get("confirmed"):
        return "confirmed"
    source = _clean_text(profile.get("source"), 24).strip().lower()
    if source.startswith("browser") or not measured:
        return "unverified"
    compared = 0
    for name, value in measured:
        table = _table_vram(name)
        if table is None:
            continue
        compared += 1
        if abs(value - table) > CONFIDENCE_TOLERANCE_GB:
            warnings.append(
                "显存与型号标称不符（实测 %.1f GB / 查表 %.1f GB），请确认" % (value, table)
            )
            return "disputed"
    return "verified" if compared else "measured"


@dataclass
class ProfileResult:
    budget: HardwareBudget
    warnings: list
    normalized: dict
    source: str
    trusted: bool
    confidence: str = "unverified"

    def to_dict(self):
        return {
            "budget": self.budget.to_dict(),
            "warnings": self.warnings,
            "normalized": self.normalized,
            "source": self.source,
            "trusted": self.trusted,
            "confidence": self.confidence,
        }


def budget_from_profile(profile, planning=True):
    """Turn an untrusted client profile into a HardwareBudget.

    Everything is clamped to a sane range and every derived number carries a
    warning, because the browser cannot read VRAM and its memory signal is a
    coarse, capped bucket.
    """
    profile = profile or {}
    warnings = []
    source = "client:" + (_clean_text(profile.get("source"), 24) or "manual")

    platform_name = normalize_platform(profile.get("platform"))
    architecture = _clean_text(profile.get("architecture"), 32) or "unknown"
    cpu_cores = _clamp(profile.get("cpu_cores"), CORES_MIN, CORES_MAX)
    ram_gb = _clamp(profile.get("ram_gb"), RAM_MIN_GB, RAM_MAX_GB)

    # B-06: gpus is untrusted. int/bool/float used to reach slicing and raise
    # TypeError -> 500; anything that is not a list is treated as no GPUs.
    raw_gpus = profile.get("gpus")
    if not isinstance(raw_gpus, list):
        raw_gpus = []

    gpus = []
    measured = []
    for raw in raw_gpus[:MAX_GPUS]:
        if not isinstance(raw, dict):
            continue
        name = _clean_text(raw.get("name"), 200)
        submitted = _clamp(raw.get("vram_gb"), VRAM_MIN_GB, VRAM_MAX_GB)
        uma_flag = bool(raw.get("uma"))
        vram = submitted
        if vram is None and not uma_flag:
            # The browser often knows only the adapter name. Fall back to the
            # table so a name-only profile is not priced at zero.
            table = _table_vram(name)
            if table is not None:
                vram = _clamp(table, VRAM_MIN_GB, VRAM_MAX_GB)
        gpus.append({
            "name": name,
            "vendor": _clean_text(raw.get("vendor"), 32) or "unknown",
            "vram_gb": vram,
            "uma": uma_flag,
        })
        if submitted is not None:
            measured.append((name, submitted))

    confidence = _cross_validate(profile, measured, warnings)

    discrete = [g for g in gpus if g["vram_gb"] and not g["uma"]]
    uma_gpu = [g for g in gpus if g["uma"]]
    uma = bool(uma_gpu) and not discrete

    if uma:
        if not ram_gb:
            warnings.append("统一内存容量未知，请确认本机内存档位")
        total = ram_gb or 0.0
        usable = total * (1 - UMA_HEADROOM_RATIO) if planning else total * 0.5
        device_name = uma_gpu[0]["name"] if uma_gpu else "Unified memory"
    else:
        if not discrete:
            warnings.append("未识别到独立显卡显存，请手动填写")
        total = max((g["vram_gb"] or 0.0) for g in gpus) if gpus else 0.0
        if planning:
            margin = max(DISCRETE_MARGIN_FLOOR / GIB, total * DISCRETE_MARGIN_RATIO)
            usable = max(0.0, total - margin)
        else:
            usable = total
        device_name = discrete[0]["name"] if discrete else (gpus[0]["name"] if gpus else "Unknown GPU")

    if gpus and any(g["vendor"] == "unknown" for g in gpus):
        warnings.append("GPU 型号未在查表中命中，显存可能不准确")
    warnings.append("客户端提交的硬件不可信，已按上界钳制并需用户确认")

    budget = HardwareBudget(
        usable_vram_bytes=int(usable * GIB),
        total_device_bytes=int(total * GIB),
        # Free memory on a remote machine is unknowable; only a local agent can
        # provide it, and live fit checks must run there. Total RAM is still a
        # hard physical ceiling, so physics_check can use it to keep spilling
        # models visible instead of calling them impossible (B-15).
        ram_available_bytes=0,
        ram_total_bytes=int((ram_gb or 0.0) * GIB),
        uma=uma,
        source=source,
        device_name=device_name or "Unknown GPU",
    )
    normalized = {
        "source": source,
        "platform": platform_name,
        "architecture": architecture,
        "cpu_cores": int(cpu_cores) if cpu_cores else None,
        "ram_gb": round(ram_gb, 1) if ram_gb else None,
        "gpus": gpus,
        "uma": uma,
    }
    return ProfileResult(budget, warnings, normalized, source, False, confidence)
