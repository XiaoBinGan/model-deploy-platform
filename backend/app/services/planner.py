"""Parameter planner.

Borrowed from Hermes-Agent's local_runtime/context_policy.py: launch arguments
are *derived from the fit decision*, not typed in by hand. The context window
comes off a ladder (floor 64K -> x1.5 -> native cap), KV is quantized to q8_0
to buy window, and flash attention is on. The decision is returned as data so
the UI can show it and presets can record it.
"""
import os
import platform
import re
import shlex

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from . import environment
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

# --- docker contract (docs/docker-design.md §3-§5) --------------------------
DEFAULT_DOCKER_IMAGE = "vllm/vllm-openai:latest"
# §5: no whitespace, quotes, semicolon, $, backtick, backslash, &, |, >, <.
DOCKER_IMAGE_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._/:@-]{0,199}$")
DOCKER_GPUS_RE = re.compile(r"^[0-9]+(,[0-9]+)*$")
DOCKER_VOLUME_PATH_RE = re.compile(r"^/[^:\u0000]{0,400}$")
MAX_DOCKER_VOLUMES = 8
MAX_EXTRA_ARGS = 32
MAX_EXTRA_ARG_LEN = 200
DOCKER_CONTAINER_PORTS = {"vllm": 8000, "sglang": 30000}
DOCKER_DEFAULT_CONTAINER_PORT = 8080


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
    # Only meaningful when backend == "docker"; ignored otherwise. The fields
    # mirror DeployRequest in main.py, which the desktop also sends.
    image: str = ""
    gpus: str = "all"
    volumes: list[dict] = Field(default_factory=list)
    extra_args: list[str] = Field(default_factory=list)


def _entry(model_id):
    for entry in CATALOG:
        if entry.id == model_id:
            return entry
    # B-21: the UI and the default request use *variant* ids (qwen3-8b-bf16),
    # but catalog ids are base ids (qwen3-8b). Resolve the variant id back to
    # its entry instead of silently falling through to VARIANT_MEMORY.
    if not model_id:
        return None
    for entry in CATALOG:
        for variant in entry.variants:
            if f"{entry.id}-{variant['quant']}" == model_id:
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


def _cuda_platform(req):
    """Return (has_cuda, reason) for the machine this plan is for.

    --gpu-memory-utilization / --mem-fraction-static are CUDA concepts: they
    apportion *device* memory. Apple Silicon has no separate VRAM (unified
    memory) and a CPU-only host has none either, so emitting the flag there is
    noise at best. The platform comes from the client profile when present,
    otherwise from this host. Detection reuses environment.py's Apple Silicon /
    nvidia-smi knowledge instead of growing a second copy (gap 6).
    """
    if req.hardware:
        system = str(req.hardware.get("platform") or "")
        architecture = str(req.hardware.get("architecture") or "")
        gpus = req.hardware.get("gpus")
        if isinstance(gpus, list):
            for gpu in gpus:
                if not isinstance(gpu, dict):
                    continue
                vendor = str(gpu.get("vendor") or "").lower()
                name = str(gpu.get("name") or "").lower()
                if vendor == "nvidia" or "nvidia" in name or "geforce" in name or "rtx" in name:
                    return True, ""
        if environment.is_apple_silicon(system, architecture) or system.lower() in {"darwin", "macos"}:
            return False, "目标平台是 Apple Silicon/macOS，没有独立 CUDA 显存"
        # A profile means the target is the *client*, not this host. If the
        # profile does not name an NVIDIA GPU we omit the flag rather than
        # planning with the control plane's own hardware.
        return False, "目标机器未检测到 NVIDIA 显卡"
    if environment.is_apple_silicon():
        return False, "控制面本机是 Apple Silicon，没有独立 CUDA 显存"
    if environment.nvidia_devices():
        return True, ""
    return False, "控制面本机未检测到 NVIDIA CUDA 设备"


def _cuda_omitted_warning(flag, reason):
    return f"已省略 {flag}：{reason}；该参数按 CUDA 显存比例分配，非 NVIDIA 平台无独立显存可分配"


def _hf_cache_dir():
    return os.path.join(os.path.expanduser("~"), ".cache", "huggingface")


def _docker_family(image):
    """Image-specific argv/port family, keyed by image-name substring (§3/§4)."""
    name = image.lower()
    if "vllm" in name:
        return "vllm"
    if "sglang" in name:
        return "sglang"
    return "other"


def _docker_container_port(family):
    return DOCKER_CONTAINER_PORTS.get(family, DOCKER_DEFAULT_CONTAINER_PORT)


def _docker_effective_backend(image):
    """The runtime a docker image implies, for catalog variant selection.

    A vllm/sglang image is priced exactly like its native backend, so docker is
    not the one backend that bypasses the estimator. A third-party image has no
    known runtime, so variant selection falls back as before (effective backend
    None). The image-substring knowledge lives in _docker_family, not here.
    """
    family = _docker_family(image)
    return family if family in {"vllm", "sglang"} else None


def _docker_slug(model_id):
    """mdp-<slug>: ascii alphanumerics + hyphens, lowercase, max 40 chars.

    Deterministic on purpose: the desktop removes the same name with
    `docker rm -f mdp-<slug>` before every run (contract §4.1), so the preview
    and the cleanup must derive the identical name from the identical model_id.
    """
    slug = re.sub(r"[^a-z0-9-]", "", (model_id or "").lower())[:40]
    return slug or "model"


def _docker_error(message):
    raise HTTPException(status_code=400, detail=message)


def _validate_docker(req):
    """Enforce docs/docker-design.md §5. Illegal input is rejected, never cleaned."""
    image = req.image if req.image else DEFAULT_DOCKER_IMAGE
    if not DOCKER_IMAGE_RE.match(image):
        _docker_error(f"非法镜像名: {image!r}")
    gpus = req.gpus if req.gpus not in (None, "") else "all"
    if gpus not in {"all", "none"} and not DOCKER_GPUS_RE.match(str(gpus)):
        _docker_error(f"非法 gpus: {gpus!r}")

    volumes = req.volumes or []
    if not isinstance(volumes, list):
        _docker_error("volumes 必须是数组")
    if len(volumes) > MAX_DOCKER_VOLUMES:
        _docker_error(f"volumes 最多 {MAX_DOCKER_VOLUMES} 项")
    for volume in volumes:
        if not isinstance(volume, dict):
            _docker_error("volumes 每一项必须是对象")
        host = volume.get("host")
        container = volume.get("container")
        if not isinstance(host, str) or not DOCKER_VOLUME_PATH_RE.match(host):
            _docker_error(f"非法 volume host: {host!r}")
        if not isinstance(container, str) or not DOCKER_VOLUME_PATH_RE.match(container):
            _docker_error(f"非法 volume container: {container!r}")
        if "ro" in volume and not isinstance(volume["ro"], bool):
            _docker_error("volume ro 必须是布尔值")

    extra_args = req.extra_args or []
    if not isinstance(extra_args, list):
        _docker_error("extra_args 必须是数组")
    if len(extra_args) > MAX_EXTRA_ARGS:
        _docker_error(f"extra_args 最多 {MAX_EXTRA_ARGS} 项")
    for arg in extra_args:
        if not isinstance(arg, str) or len(arg) > MAX_EXTRA_ARG_LEN or any(ch in arg for ch in ("\x00", "\n", "\r")):
            _docker_error(f"非法 extra_args 项: {arg!r}")

    if not (1024 <= req.port <= 65535):
        _docker_error("port 必须在 1024~65535")
    return image, gpus, volumes, extra_args


def _docker_argv(req, window, image, gpus, volumes, extra_args):
    """Build the docker argv exactly as docs/docker-design.md §4 specifies."""
    family = _docker_family(image)
    container_port = _docker_container_port(family)
    cmd = ["docker", "run", "--rm", "--name", f"mdp-{_docker_slug(req.model_id)}",
           "-p", f"127.0.0.1:{req.port}:{container_port}"]
    if gpus != "none":
        cmd += ["--gpus", gpus]
    for volume in volumes:
        mount = f"{volume['host']}:{volume['container']}"
        if volume.get("ro"):
            mount += ":ro"
        cmd += ["-v", mount]
    # HF_HOME always points at /hf: --rm would otherwise re-download multi-GB
    # weights on every launch. But if the user already mounted something at /hf,
    # the auto-mount would silently shadow it (the later mount wins in Docker),
    # so we skip ours and leave the choice to them.
    cmd += ["-e", "HF_HOME=/hf"]
    if not any(isinstance(v, dict) and v.get("container") == "/hf" for v in volumes):
        cmd += ["-v", f"{_hf_cache_dir()}:/hf"]
    cmd += [image]
    if family == "vllm":
        cmd += ["--model", req.model_path, "--host", "0.0.0.0", "--port", str(container_port),
                "--max-model-len", str(window)]
    elif family == "sglang":
        cmd += ["--model-path", req.model_path, "--host", "0.0.0.0", "--port", str(container_port),
                "--context-length", str(window)]
    cmd += list(extra_args)
    return cmd, container_port


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
    # Docker is not a runtime: the image decides it. Validate up front so an
    # illegal image is a 400 before any pricing work, then price vllm/sglang
    # images exactly like their native backend. A third-party image keeps the
    # old fallback behaviour.
    docker_fields = None
    effective_backend = req.backend
    if req.backend == "docker":
        docker_fields = _validate_docker(req)
        effective_backend = _docker_effective_backend(docker_fields[0])
    variant = _pick_variant(entry, req.quantization, effective_backend or req.backend) if entry else None

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
    cuda_ok = True
    cuda_reason = ""
    if req.backend in {"vllm", "sglang"}:
        cuda_ok, cuda_reason = _cuda_platform(req)

    if req.backend == "vllm":
        cmd = ["vllm", "serve", req.model_path, "--host", "127.0.0.1", "--port", str(req.port),
               "--dtype", req.dtype, "--max-model-len", str(window)]
        if cuda_ok:
            cmd += ["--gpu-memory-utilization", str(req.gpu_memory_utilization)]
        else:
            warnings.append(_cuda_omitted_warning("--gpu-memory-utilization", cuda_reason))
        cmd += ["--max-num-seqs", str(req.max_num_seqs)]
        if req.quantization in {"awq", "gptq"}: cmd += ["--quantization", req.quantization]
    elif req.backend == "sglang":
        cmd = ["python", "-m", "sglang.launch_server", "--model-path", req.model_path,
               "--host", "127.0.0.1", "--port", str(req.port), "--dtype", req.dtype,
               "--context-length", str(window)]
        if cuda_ok:
            cmd += ["--mem-fraction-static", str(req.gpu_memory_utilization)]
        else:
            warnings.append(_cuda_omitted_warning("--mem-fraction-static", cuda_reason))
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
    elif req.backend == "docker":
        image, gpus, volumes, extra_args = docker_fields
        cmd, container_port = _docker_argv(req, window, image, gpus, volumes, extra_args)
        decision["docker"] = {
            "name": f"mdp-{_docker_slug(req.model_id)}",
            "image": image,
            "gpus": gpus,
            "container_port": container_port,
            "hf_cache": _hf_cache_dir(),
            "effective_backend": effective_backend,
        }
        decision["docker_effective_backend"] = effective_backend
        decision["note"] = "控制面只生成 docker argv 预览；容器由桌面端在本机启动"
    else:
        cmd = ["ollama", "run", req.model_path]

    decision["flash_attention"] = req.backend in {"llama.cpp", "llamacpp", "vllm", "sglang"}

    return {
        "status": status,
        "estimated_memory_gb": estimated,
        "predicted_decode_tok_s": tok_s,
        "warnings": warnings,
        "command": cmd,
        # shlex.join, not " ".join: the string is shown to users to copy into a
        # shell, so a model path containing spaces or metacharacters must stay
        # one argument instead of becoming several commands.
        "command_string": shlex.join(cmd),
        "decision": decision,
        "hardware": budget.to_dict(),
        "hardware_source": hardware_source,
    }
