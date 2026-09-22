"""Model catalog + recommendation API.

The heavy lifting lives in two borrowed layers:
  * services/hardware.py  -> HardwareBudget (measured, not assumed)
  * services/catalog.py   -> pure resolver returning a reason_key
This module is only the HTTP shape plus local-checkpoint bookkeeping.
"""
import json
import subprocess
from pathlib import Path
from fastapi import APIRouter
from pydantic import BaseModel

from .hardware import probe_budget, budget_from_profile, GIB
from . import catalog as catalog_service
from .catalog import REASON_KEYS, CATALOG
from .estimator import COMFORT_DECODE_TOK_S

router = APIRouter()
ROOTS = [Path("G:/models"), Path("/models"), Path.home() / ".ollama" / "models"]


class RecommendRequest(BaseModel):
    task: str = "chat"
    goal: str = "balanced"  # balanced, quality, low-memory, throughput, low-latency
    concurrency: int = 4
    available_vram_gb: float | None = None
    backend: str = "ollama"
    prefer_quantized: bool | None = None
    require_local: bool = False
    limit: int = 20
    live: bool = False
    # Untrusted client hardware profile. When present the resolver prices the
    # catalog against the *client's* machine, not the server's.
    hardware: dict | None = None
    client_is_local: bool = True


def _command(args):
    try:
        p = subprocess.run(args, capture_output=True, text=True, encoding="utf-8",
                           errors="replace", timeout=5)
        return p.stdout.strip()
    except Exception:
        return ""


def scan_models():
    result = []
    for root in ROOTS:
        if not root.exists():
            continue
        for cfg in root.rglob("config.json"):
            try:
                data = json.loads(cfg.read_text(encoding="utf-8"))
                weights = list(cfg.parent.glob("*.safetensors")) + list(cfg.parent.glob("*.bin"))
                total = sum(x.stat().st_size for x in weights) / GIB
                result.append({
                    "id": cfg.parent.name,
                    "name": cfg.parent.name,
                    "path": str(cfg.parent),
                    "architecture": (data.get("architectures") or ["unknown"])[0],
                    "context_length": data.get("max_position_embeddings", 0),
                    "weight_size_gb": round(total, 2),
                    "quantization": (data.get("quantization_config") or {}).get("quant_method"),
                    "status": "READY" if weights else "PARTIAL",
                })
            except Exception:
                continue
    return result


def _local_ready(entry, local_models):
    """A catalog entry is local_ready only when a real checkpoint exists."""
    names = {entry.id.lower()}
    for key in ("huggingface", "ollama"):
        value = entry.source.get(key)
        if value:
            names.add(str(value).lower().replace("/", "--"))
            names.add(str(value).split("/")[-1].lower())
    for model in local_models:
        if model["status"] != "READY":
            continue
        candidate = model["id"].lower()
        if candidate in names or any(candidate.startswith(n) for n in names if len(n) > 4):
            return True, model.get("path")
    return False, None


def _goal_bonus(goal, row):
    quant = row.get("quantization")
    params = row.get("params_b") or 0
    if goal == "quality":
        return params * 3 + (18 if quant in {"bf16", "q8_0"} else 0)
    if goal == "low-memory":
        return 24 if quant in {"awq", "gptq", "q4_k_m"} else 8 if quant == "fp8" else 0
    if goal == "throughput":
        return 28 if quant == "fp8" else 18 if quant in {"awq", "gptq"} else 6
    if goal == "low-latency":
        return max(0, 40 - params * 2)
    band = 24 if 4 <= params <= 14 else 4
    return band + (20 if quant in {"bf16", "q8_0"} else 0) + min(params, 14) * 2


@router.get("/models/catalog")
def catalog():
    return {
        "models": [entry.to_dict() for entry in CATALOG],
        "reason_keys": REASON_KEYS,
        "quantization_policy": {
            "vllm_sglang": ["bf16", "fp8", "awq", "gptq"],
            "ollama_llamacpp": ["q8_0", "q4_k_m"],
            "transformers_only": ["bitsandbytes"],
        },
        "context_policy": {"floor": 65536, "target": 147456, "note": "64K 是承诺，144K 是目标"},
    }


@router.get("/models/local")
def local():
    return {"models": scan_models()}


@router.post("/models/recommend")
def recommend(req: RecommendRequest):
    # The budget is an input, not a server measurement: a shared service must
    # price the catalog against the caller's machine, not its own.
    profile_result = None
    if req.hardware:
        profile_result = budget_from_profile(req.hardware, planning=not req.live)
        budget = profile_result.budget
    else:
        budget = probe_budget(planning=not req.live)
    if req.available_vram_gb:
        budget.usable_vram_bytes = int(req.available_vram_gb * GIB)
    if req.available_vram_gb and not budget.uma:
        budget.total_device_bytes = max(budget.total_device_bytes, budget.usable_vram_bytes)

    hardware_warnings = list(profile_result.warnings) if profile_result else []
    if not req.client_is_local and not req.hardware:
        hardware_warnings.append("远端请求且未提供客户端硬件，当前显示的是服务器硬件")

    resolved = catalog_service.resolve(budget, backend=req.backend)
    local_models = scan_models()

    rows = []
    for choice in resolved["choices"]:
        row = choice.to_dict()
        ready, path = _local_ready(choice.entry, local_models)
        row["availability"] = "local_ready" if ready else "download_required"
        row["local_path"] = path
        row["source_status"] = "local_ready" if ready else "remote_unverified"
        row["task_match"] = req.task in choice.entry.capabilities
        row["recommended"] = choice is resolved["pick"]
        if req.require_local and not ready:
            continue
        rows.append(row)

    def sort_key(row):
        return (
            1 if row["recommended"] else 0,
            1 if row["fits"] else 0,
            1 if row["zero_spill"] else 0,
            1 if row["task_match"] else 0,
            _goal_bonus(req.goal, row) + (30 if row["availability"] == "local_ready" else 0)
            + (20 if req.prefer_quantized and row["quantization"] not in {None, "bf16", "q8_0"} else 0)
            - (15 if req.prefer_quantized is False and row["quantization"] in {"awq", "gptq", "q4_k_m"} else 0),
            row["quality"],
        )

    rows.sort(key=sort_key, reverse=True)
    pick = resolved["pick"]
    recommendation = None
    if pick is not None:
        recommendation = pick.to_dict()
        recommendation["reason_key"] = resolved["reason_key"]
        recommendation["reason"] = REASON_KEYS.get(resolved["reason_key"], resolved["reason_key"])

    return {
        "mode": "resolver",
        "hardware": budget.to_dict(),
        "client_is_local": req.client_is_local,
        "hardware_source": budget.source,
        "hardware_trusted": profile_result.trusted if profile_result else True,
        "hardware_warnings": hardware_warnings,
        "normalized_profile": profile_result.normalized if profile_result else None,
        "comfort_decode_tok_s": COMFORT_DECODE_TOK_S,
        "recommendation": recommendation,
        "reason_key": resolved["reason_key"],
        "reason": REASON_KEYS.get(resolved["reason_key"], resolved["reason_key"]),
        "recommendations": rows[: max(1, min(req.limit, len(rows)))],
        "total_candidates": len(rows),
        "reason_keys": REASON_KEYS,
        "selection_policy": {
            "hard_memory_gate": True,
            "auto_recommend_requires_zero_spill": True,
            "speed_is_a_gate_not_a_promise": True,
            "note": "唯一硬拒绝是物理放不下；其余全部降级为可见、可解释、需显式选择。",
        },
    }
