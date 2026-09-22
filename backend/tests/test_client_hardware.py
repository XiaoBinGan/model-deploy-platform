"""Client hardware profile contract tests."""
import pytest

from types import SimpleNamespace

from fastapi import HTTPException

from app import main
from app.services import gpu_table, hardware, profiles
from app.services.models import RecommendRequest, recommend


def _request(host):
    return SimpleNamespace(
        client=SimpleNamespace(host=host),
        headers={},
        url=SimpleNamespace(hostname=host),
        base_url="http://example/",
    )


def test_remote_deploy_is_blocked_by_default():
    with pytest.raises(HTTPException) as exc:
        main.create_deployment(
            main.DeployRequest(model_path="x", model_id="x", backend="transformers"),
            _request("10.0.0.5"),
        )
    assert exc.value.status_code == 403
    assert "你的机器" in exc.value.detail


def test_local_deploy_is_allowed():
    dep = main.create_deployment(
        main.DeployRequest(model_path="/models/x", model_id="x", backend="transformers"),
        _request("127.0.0.1"),
    )
    assert dep["status"] == "CREATED"


def test_apple_gpu_is_unified_memory():
    out = gpu_table.lookup("Apple M4 Pro")
    assert out["matched"]
    assert out["vendor"] == "apple"
    assert out["uma"] is True
    assert out["vram_gb"] is None


def test_discrete_gpu_lookup_is_specific_before_prefix():
    assert gpu_table.lookup("NVIDIA GeForce RTX 4090")["vram_gb"] == 24
    assert gpu_table.lookup("NVIDIA GeForce RTX 4070 Ti")["vram_gb"] == 16
    assert gpu_table.lookup("NVIDIA GeForce RTX 4070")["vram_gb"] == 12
    assert gpu_table.lookup("NVIDIA GeForce RTX 3060")["vram_gb"] == 12


def test_unknown_gpu_falls_back_to_asking():
    out = gpu_table.lookup("Totally Unknown Accelerator")
    assert out["matched"] is False
    assert out["vram_gb"] is None


def test_profile_is_clamped_and_untrusted():
    result = hardware.budget_from_profile({
        "source": "browser",
        "cpu_cores": 999999,
        "ram_gb": 1e9,
        "gpus": [{"name": "Apple M3 Max", "vendor": "apple", "uma": True}],
    })
    assert result.trusted is False
    assert result.normalized["cpu_cores"] == hardware.CORES_MAX
    assert result.normalized["ram_gb"] == hardware.RAM_MAX_GB
    assert result.budget.uma is True
    assert result.warnings


def test_uma_profile_budget_uses_headroom():
    result = hardware.budget_from_profile({
        "ram_gb": 24,
        "gpus": [{"name": "Apple M4", "vendor": "apple", "uma": True}],
    })
    assert result.budget.uma is True
    assert 18.0 < result.budget.usable_vram_gb < 20.0


def test_discrete_profile_budget_subtracts_margin():
    result = hardware.budget_from_profile({
        "ram_gb": 64,
        "gpus": [{"name": "NVIDIA GeForce RTX 4090", "vendor": "nvidia", "vram_gb": 24, "uma": False}],
    })
    assert result.budget.uma is False
    assert 20.0 < result.budget.usable_vram_gb < 24.0


def test_profile_code_round_trip():
    profile = {"source": "agent", "ram_gb": 36, "gpus": [{"name": "Apple M3 Max", "uma": True}]}
    code = profiles.encode_profile(profile)
    assert code.startswith("mdp1.")
    assert profiles.decode_profile(code) == profile


def test_profile_code_detects_tampering():
    code = profiles.encode_profile({"ram_gb": 8})
    payload, digest = code.split(".")[1], code.split(".")[2]
    tampered = "mdp1." + payload + "." + ("0" if digest[0] != "0" else "1") + digest[1:]
    with pytest.raises(ValueError):
        profiles.decode_profile(tampered)
    with pytest.raises(ValueError):
        profiles.decode_profile("not-a-code")


def test_parse_accepts_json_or_code():
    assert profiles.parse_profile_input('{"ram_gb": 16}') == {"ram_gb": 16}
    code = profiles.encode_profile({"ram_gb": 32})
    assert profiles.parse_profile_input(code) == {"ram_gb": 32}


def test_recommend_uses_client_profile_not_server():
    # 8 GB unified client must not be priced against this host's memory.
    out = recommend(RecommendRequest(
        backend="ollama",
        hardware={"source": "browser", "ram_gb": 8,
                  "gpus": [{"name": "Apple M2", "vendor": "apple", "uma": True}]},
        client_is_local=False,
    ))
    assert out["hardware"]["uma"] is True
    assert out["hardware"]["usable_vram_gb"] < 8.0
    assert out["hardware_trusted"] is False
    assert out["client_is_local"] is False
    assert out["hardware_source"] == "client:browser"
    for row in out["recommendations"]:
        if row["zero_spill"]:
            assert row["memory_gb"] < 8.0
