"""Docker plan preview: argv shape and §5 validation (docs/docker-design.md).

Each test fails on the pre-fix code, which had no docker branch at all.
"""
import os

import pytest
from fastapi import HTTPException

from app.services import planner
from app.services.catalog import CATALOG
from app.services.estimator import plan_window
from app.services.hardware import budget_from_profile

HF_CACHE = os.path.join(os.path.expanduser("~"), ".cache", "huggingface")


def _preview(**kwargs):
    kwargs.setdefault("backend", "docker")
    kwargs.setdefault("model_id", "qwen3-8b")
    kwargs.setdefault("model_path", "/models/qwen3-8b")
    return planner.preview(planner.PlanRequest(**kwargs))


def test_docker_argv_matches_contract():
    out = _preview(
        port=8001,
        image="vllm/vllm-openai:latest",
        gpus="all",
        volumes=[
            {"host": "/host/models", "container": "/models", "ro": True},
            {"host": "/host/data", "container": "/data"},
        ],
        extra_args=["--max-num-seqs", "4"],
    )
    cmd = out["command"]
    assert cmd[:5] == ["docker", "run", "--rm", "--name", "mdp-qwen3-8b"]
    assert cmd[5:7] == ["-p", "127.0.0.1:8001:8000"]
    assert cmd[7:9] == ["--gpus", "all"]
    assert cmd[9:13] == ["-v", "/host/models:/models:ro", "-v", "/host/data:/data"]
    assert cmd[13:17] == ["-e", "HF_HOME=/hf", "-v", f"{HF_CACHE}:/hf"]
    image_index = cmd.index("vllm/vllm-openai:latest")
    assert cmd[image_index + 1:image_index + 9] == [
        "--model", "/models/qwen3-8b", "--host", "0.0.0.0", "--port", "8000",
        "--max-model-len", str(out["decision"]["planned_window"]),
    ]
    assert cmd[image_index + 9:] == ["--max-num-seqs", "4"]


def test_docker_gpus_none_omits_the_gpus_flag_entirely():
    out = _preview(gpus="none")
    assert "--gpus" not in out["command"]


def test_docker_sglang_image_uses_port_30000_and_context_length():
    out = _preview(image="lmsysorg/sglang:latest", port=8002)
    cmd = out["command"]
    assert cmd[5:7] == ["-p", "127.0.0.1:8002:30000"]
    image_index = cmd.index("lmsysorg/sglang:latest")
    assert cmd[image_index + 1:image_index + 9] == [
        "--model-path", "/models/qwen3-8b", "--host", "0.0.0.0", "--port", "30000",
        "--context-length", str(out["decision"]["planned_window"]),
    ]


def test_docker_unknown_image_gets_no_runtime_args():
    out = _preview(image="ghcr.io/ggml-org/llama.cpp:server", port=8003,
                   extra_args=["--jinja"])
    cmd = out["command"]
    assert cmd[5:7] == ["-p", "127.0.0.1:8003:8080"]
    image_index = cmd.index("ghcr.io/ggml-org/llama.cpp:server")
    assert cmd[image_index + 1:] == ["--jinja"]


def test_docker_hf_cache_is_always_mounted():
    out = _preview()
    cmd = out["command"]
    assert ["-e", "HF_HOME=/hf"] == cmd[cmd.index("-e"):cmd.index("-e") + 2]
    assert f"{HF_CACHE}:/hf" in cmd


def test_docker_empty_image_falls_back_to_default():
    out = _preview(image="")
    assert "vllm/vllm-openai:latest" in out["command"]


def test_docker_name_is_deterministic_for_repeated_previews():
    first = _preview(model_id="Qwen/Qwen3-8B")["command"]
    second = _preview(model_id="Qwen/Qwen3-8B")["command"]
    assert first[4] == "mdp-qwenqwen3-8b"
    assert first[4] == second[4]


def test_docker_user_hf_mount_is_not_shadowed():
    out = _preview(volumes=[{"host": "/tmp/hf", "container": "/hf"}])
    cmd = out["command"]
    assert [item for item in cmd if item.endswith(":/hf")] == ["/tmp/hf:/hf"]
    assert f"{HF_CACHE}:/hf" not in cmd
    assert ["-e", "HF_HOME=/hf"] == cmd[cmd.index("-e"):cmd.index("-e") + 2]


def test_docker_slug_is_bounded_and_ascii():
    assert planner._docker_slug("Qwen/Qwen3-8B") == "qwenqwen3-8b"
    assert planner._docker_slug("a" * 100) == "a" * 40
    assert planner._docker_slug("模型") == "model"


@pytest.mark.parametrize("bad_image", ["vllm image", "vllm;rm -rf /", "vllm$(id)", 'vllm"x"', "vllm|x"])
def test_docker_rejects_illegal_image(bad_image):
    with pytest.raises(HTTPException) as exc:
        _preview(image=bad_image)
    assert exc.value.status_code == 400


@pytest.mark.parametrize("bad_gpus", ["0;1", "0 1", "all,none", "-1"])
def test_docker_rejects_illegal_gpus(bad_gpus):
    with pytest.raises(HTTPException) as exc:
        _preview(gpus=bad_gpus)
    assert exc.value.status_code == 400


def test_docker_accepts_device_list_gpus():
    out = _preview(gpus="0,1")
    assert ["--gpus", "0,1"] == out["command"][7:9]


def test_docker_rejects_relative_volume_host():
    with pytest.raises(HTTPException) as exc:
        _preview(volumes=[{"host": "models", "container": "/models"}])
    assert exc.value.status_code == 400


def test_docker_rejects_too_many_volumes():
    volumes = [{"host": f"/host/{i}", "container": f"/c/{i}"} for i in range(9)]
    with pytest.raises(HTTPException) as exc:
        _preview(volumes=volumes)
    assert exc.value.status_code == 400


def test_docker_rejects_extra_arg_with_newline():
    with pytest.raises(HTTPException) as exc:
        _preview(extra_args=["--flag\nrm -rf /"])
    assert exc.value.status_code == 400


def test_docker_rejects_too_many_extra_args():
    with pytest.raises(HTTPException) as exc:
        _preview(extra_args=["--x"] * 33)
    assert exc.value.status_code == 400


@pytest.mark.parametrize("bad_port", [80, 0, 70000, -1])
def test_docker_rejects_out_of_range_port(bad_port):
    with pytest.raises(HTTPException) as exc:
        _preview(port=bad_port)
    assert exc.value.status_code == 400


def test_http_preview_returns_400_for_illegal_docker_fields():
    from fastapi.testclient import TestClient

    from app.main import app

    client = TestClient(app)
    bad = client.post("/api/plans/preview", json={
        "backend": "docker", "model_id": "qwen3-8b", "image": "vllm; rm -rf /"})
    assert bad.status_code == 400
    assert "非法镜像名" in bad.json()["detail"]

    good = client.post("/api/plans/preview", json={
        "backend": "docker", "model_id": "qwen3-8b", "model_path": "/models/x", "port": 8001})
    assert good.status_code == 200
    assert good.json()["command"][:5] == ["docker", "run", "--rm", "--name", "mdp-qwen3-8b"]


def test_docker_vllm_image_reuses_catalog_pricing():
    hardware = {"source": "browser", "platform": "linux", "ram_gb": 64,
                "gpus": [{"name": "NVIDIA GeForce RTX 4090", "vendor": "nvidia",
                          "vram_gb": 24, "uma": False}]}
    out = _preview(model_id="qwen3-8b-bf16", image="vllm/vllm-openai:latest",
                   max_model_len=12345, hardware=hardware)
    assert out["decision"]["entry_id"] == "qwen3-8b"
    assert out["decision"]["variant"] == "bf16"
    assert out["decision"]["docker_effective_backend"] == "vllm"
    # Derive the expected window from the estimator instead of hard-coding it:
    # the B-08 fix (window must not exceed native_ctx) will change the number,
    # and this test must not go red with it.
    entry = next(e for e in CATALOG if e.id == "qwen3-8b")
    variant = next(v for v in entry.variants if v["quant"] == "bf16")
    budget = budget_from_profile(hardware).budget
    assert out["decision"]["planned_window"] == plan_window(entry.profile(variant), budget, "q8_0")
    assert out["decision"]["planned_window"] != 12345


def test_docker_third_party_image_keeps_the_fallback_window():
    out = _preview(model_id="qwen3-8b-bf16", image="ghcr.io/ggml-org/llama.cpp:server",
                   max_model_len=12345)
    assert out["decision"]["docker_effective_backend"] is None
    assert out["decision"]["variant"] == "custom"
    assert out["decision"]["planned_window"] == 12345


def test_docker_vllm_image_on_apple_omits_gpu_memory_utilization():
    out = _preview(
        model_id="qwen3-8b-bf16", image="vllm/vllm-openai:latest",
        hardware={"source": "browser", "platform": "darwin", "architecture": "arm64",
                  "ram_gb": 24,
                  "gpus": [{"name": "Apple M5", "vendor": "apple", "uma": True}]},
    )
    assert out["decision"]["docker_effective_backend"] == "vllm"
    # Docker's vllm argv never carries the CUDA-only memory fraction (contract
    # §4), so there is nothing to omit and no warning to emit.
    assert "--gpu-memory-utilization" not in out["command"]


def test_non_docker_backend_ignores_docker_fields():
    out = planner.preview(planner.PlanRequest(
        backend="llama.cpp", model_id="qwen3-8b", model_path="/models/qwen3-8b.gguf",
        image="bad image;", gpus="0;1", volumes=[{"host": "relative", "container": "/c"}],
        extra_args=["bad\narg"],
    ))
    assert out["command"][0] == "llama-server"
