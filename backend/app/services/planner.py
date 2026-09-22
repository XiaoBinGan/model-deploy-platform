"""Parameter planner.

Borrowed from Hermes-Agent's local_runtime/context_policy.py: launch arguments
are *derived from the fit decision*, not typed in by hand. The context window
comes off a ladder (floor 64K -> x1.5 -> native cap), KV is quantized to q8_0
to buy window, and flash attention is on. The decision is returned as data so
the UI can show it and presets can record it.
"""
from fastapi import APIRouter
from pydantic import BaseModel, Field

from .hardware import probe_budget, budget_from_profile, GIB
from .catalog import CATALOG
from .estimator import (
    plan_window, resident_bytes, predicted_decode_tok_s,
    FLOOR_WINDOW, TARGET_WINDOW, COMFORT_DECODE_TOK_S, KV_QUANT_SCALE,
)

router = APIRouter()

VARIANT_MEMORY = {
    "qwen3-8b-bf16": 18.0, "qwen3-8b-fp8": 12.0, "qwen3-8b-awq": 9.0,
    "qwen3-8b-gptq": 9.0, "qwen3-4b-bf16": 10.0, "qwen25-coder-7b-awq": 8.5,
}


class PlanRequest(BaseModel):
    model_path: str = "G:/models/Qwen3-8B"
    model_id: str = "qwen3-8b-bf16"
    backend: str = "vllm"
    port: int = 8000
    dtype: str = "bfloat16"
    quantization: str | None = None
    max_model_len: int = 32768
    max_num_seqs: int = 8
    gpu_memory_utilization: float = Field(.9, ge=.5, le=.99)
    kv_quant: str = "q8_0"
    # A shared service must size the plan for the *client* machine. Passing a
    # profile switches the budget source; omitting it keeps the server probe.
    hardware: dict | None = None


def _entry(model_id):
    for entry in CATALOG:
        if entry.id == model_id:
            return entry
    return None


def _pick_variant(entry, quantization, backend):
    for variant in entry.variants:
        if quantization and variant["quant"] != quantization:
            continue
        if backend and backend not in variant["backends"]:
            continue
        return variant
    return None


def _estimate(entry, variant, window, kv_quant):
    profile = entry.profile(variant)
    return round(profile.footprint_bytes(window, kv_quant) / GIB, 2), profile


@router.post("/plans/preview")
def preview(req: PlanRequest):
    if req.hardware:
        profile_result = budget_from_profile(req.hardware)
        budget = profile_result.budget
        hardware_source = profile_result.source
    else:
        budget = probe_budget(planning=True)
        hardware_source = "server"
    warnings = []
    status = "PASS"
    decision = {
        "window_ladder": "64K -> x1.5 -> native",
        "floor_window": FLOOR_WINDOW,
        "target_window": TARGET_WINDOW,
        "kv_quant": req.kv_quant,
        "uma": budget.uma,
    }

    entry = _entry(req.model_id)
    variant = _pick_variant(entry, req.quantization, req.backend) if entry else None

    if req.quantization == "bitsandbytes" and req.backend in {"vllm", "sglang"}:
        status = "BLOCKED"
        warnings.append("vLLM/SGLang 不把 BitsAndBytes 作为通用的运行时量化方案，请使用预量化 AWQ/GPTQ/FP8 checkpoint")

    if entry and variant:
        profile = entry.profile(variant)
        window = plan_window(profile, budget, req.kv_quant)
        estimated = round(profile.footprint_bytes(window, req.kv_quant) / GIB, 1)
        resident = resident_bytes(profile, budget, window, req.kv_quant)
        zero_spill = resident <= budget.usable_vram_bytes
        if not zero_spill and status != "BLOCKED":
            status = "WARNING"
            warnings.append(
                f"无法完全驻留，溢出约 {round((resident - budget.usable_vram_bytes) / GIB, 1)}GB 到系统内存；"
                "请换更小的量化，不要砍上下文"
            )
        tok_s = predicted_decode_tok_s(profile, window, req.kv_quant, budget, zero_spill, entry.decode_fraction)
        if zero_spill and tok_s < COMFORT_DECODE_TOK_S:
            status = "WARNING" if status == "PASS" else status
            warnings.append(f"预测解码速度低于舒适线（{COMFORT_DECODE_TOK_S} tok/s），仅用于排序不作承诺")
        decision.update({
            "entry_id": entry.id,
            "variant": variant["quant"],
            "planned_window": window,
            "zero_spill": zero_spill,
            "resident_gb": round(resident / GIB, 2),
            "usable_vram_gb": budget.usable_vram_gb,
        })
    else:
        base = VARIANT_MEMORY.get(req.model_id, 18 if "8b" in req.model_id else 10)
        estimated = round(base + req.max_model_len / 32768 * 2 + req.max_num_seqs * .35, 1)
        window = req.max_model_len
        tok_s = None
        zero_spill = estimated <= budget.usable_vram_gb
        decision.update({"entry_id": req.model_id, "variant": req.quantization or "custom",
                         "planned_window": window, "zero_spill": zero_spill})
        if estimated > budget.usable_vram_gb:
            if status == "PASS":
                status = "WARNING"
            warnings.append("预计显存超过安全预算，请降低上下文、并发或换更小的量化")

    # ---- command is derived from the decision ----
    if req.backend == "vllm":
        cmd = ["vllm", "serve", req.model_path, "--host", "127.0.0.1", "--port", str(req.port),
               "--dtype", req.dtype, "--max-model-len", str(window),
               "--gpu-memory-utilization", str(req.gpu_memory_utilization),
               "--max-num-seqs", str(req.max_num_seqs)]
        if req.quantization in {"awq", "gptq"}: cmd += ["--quantization", req.quantization]
    elif req.backend == "sglang":
        cmd = ["python", "-m", "sglang.launch_server", "--model-path", req.model_path,
               "--host", "127.0.0.1", "--port", str(req.port), "--dtype", req.dtype,
               "--context-length", str(window), "--mem-fraction-static", str(req.gpu_memory_utilization)]
        if req.quantization in {"awq", "gptq"}: cmd += ["--quantization", req.quantization]
    elif req.backend in {"llama.cpp", "llamacpp"}:
        cmd = ["llama-server", "-m", req.model_path, "--host", "127.0.0.1", "--port", str(req.port),
               "-c", str(window), "-ctk", req.kv_quant, "-ctv", req.kv_quant, "-fa", "on",
               "-ngl", "99"]
    elif req.backend == "ollama":
        cmd = ["ollama", "run", req.model_path]
        decision["note"] = "Ollama 由守护进程托管，窗口与 KV 量化由 Modelfile 参数决定"
    elif req.backend == "transformers":
        cmd = ["python", "-m", "app.runtimes.transformers_server", "--model-path", req.model_path,
               "--host", "127.0.0.1", "--port", str(req.port), "--dtype", req.dtype]
    else:
        cmd = ["ollama", "run", req.model_path]

    decision["flash_attention"] = req.backend in {"llama.cpp", "llamacpp", "vllm", "sglang"}

    return {
        "status": status,
        "estimated_memory_gb": estimated,
        "predicted_decode_tok_s": tok_s,
        "warnings": warnings,
        "command": cmd,
        "command_string": " ".join(cmd),
        "decision": decision,
        "hardware": budget.to_dict(),
        "hardware_source": hardware_source,
    }
