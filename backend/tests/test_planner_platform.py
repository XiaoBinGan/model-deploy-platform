"""Gap 6 (CUDA flags on non-NVIDIA platforms) and B-21 (variant ids).

Both fail on the pre-fix code: it always emitted --gpu-memory-utilization and
never resolved a variant id to its catalog entry.
"""
from app.services import planner


def _apple_profile():
    return {
        "source": "browser", "platform": "darwin", "architecture": "arm64", "ram_gb": 24,
        "gpus": [{"name": "Apple M5", "vendor": "apple", "uma": True}],
    }


def test_entry_resolves_catalog_variant_ids():
    assert planner._entry("qwen3-8b").id == "qwen3-8b"
    assert planner._entry("qwen3-8b-bf16").id == "qwen3-8b"
    assert planner._entry("qwen3-8b-awq").id == "qwen3-8b"
    assert planner._entry("does-not-exist") is None


def test_default_plan_uses_the_catalog_not_the_variant_memory_fallback():
    # Default PlanRequest.model_id is the *variant* id qwen3-8b-bf16. Before the
    # fix it never matched a catalog entry, so the rough VARIANT_MEMORY branch
    # ran and decision.variant became "custom".
    out = planner.preview(planner.PlanRequest())
    assert out["decision"]["entry_id"] == "qwen3-8b"
    assert out["decision"]["variant"] == "bf16"


def test_vllm_omits_gpu_memory_utilization_on_apple_silicon():
    out = planner.preview(planner.PlanRequest(backend="vllm", hardware=_apple_profile()))
    assert "--gpu-memory-utilization" not in out["command"]
    assert any("--gpu-memory-utilization" in w for w in out["warnings"])


def test_sglang_omits_mem_fraction_on_apple_silicon():
    out = planner.preview(planner.PlanRequest(backend="sglang", hardware=_apple_profile()))
    assert "--mem-fraction-static" not in out["command"]
    assert any("--mem-fraction-static" in w for w in out["warnings"])


def test_vllm_keeps_gpu_memory_utilization_on_nvidia_profile():
    out = planner.preview(planner.PlanRequest(backend="vllm", hardware={
        "source": "browser", "platform": "linux", "ram_gb": 64,
        "gpus": [{"name": "NVIDIA GeForce RTX 4090", "vendor": "nvidia",
                  "vram_gb": 24, "uma": False}],
    }))
    assert "--gpu-memory-utilization" in out["command"]
    assert not any("--gpu-memory-utilization" in w for w in out["warnings"])


def test_server_probe_on_apple_silicon_omits_the_flag(monkeypatch):
    monkeypatch.setattr(planner.environment.platform, "system", lambda: "Darwin")
    monkeypatch.setattr(planner.environment.platform, "machine", lambda: "arm64")
    out = planner.preview(planner.PlanRequest(backend="vllm", model_id="qwen3-8b"))
    assert "--gpu-memory-utilization" not in out["command"]
    assert any("--gpu-memory-utilization" in w for w in out["warnings"])


def test_win32_profile_without_nvidia_warns_about_the_target_not_the_host():
    # A Windows client must not be told "this machine is Apple Silicon" just
    # because the control plane happens to run on a Mac.
    out = planner.preview(planner.PlanRequest(backend="vllm", hardware={
        "source": "browser", "platform": "win32", "architecture": "x86_64",
        "ram_gb": 16, "gpus": [],
    }))
    assert "--gpu-memory-utilization" not in out["command"]
    warning = next(w for w in out["warnings"] if "--gpu-memory-utilization" in w)
    assert "目标机器未检测到 NVIDIA 显卡" in warning
    assert "Apple Silicon" not in warning


def test_server_probe_on_nvidia_keeps_the_flag(monkeypatch):
    monkeypatch.setattr(planner.environment.platform, "system", lambda: "Linux")
    monkeypatch.setattr(planner.environment.platform, "machine", lambda: "x86_64")
    monkeypatch.setattr(planner.environment, "nvidia_devices",
                        lambda: [{"name": "NVIDIA RTX 4090"}])
    out = planner.preview(planner.PlanRequest(backend="vllm", model_id="qwen3-8b"))
    assert "--gpu-memory-utilization" in out["command"]
