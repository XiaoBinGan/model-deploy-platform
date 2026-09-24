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
    # This is the trust boundary, not a status check: a local caller is let
    # through (no 403), while the remote case above is blocked. Creating an
    # unavailable backend now honestly reports BLOCKED, which is not asserted
    # away here.
    main.create_deployment(
        main.DeployRequest(model_path="/models/x", model_id="x", backend="transformers"),
        _request("127.0.0.1"),
    )


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

def test_planner_sizes_for_client_profile_not_server():
    """A shared service must not plan against its own GPU.

    The RTX 3060 profile below is deliberately not this host, so the budget and
    window can only have come from the client profile.
    """
    from app.services import planner

    out = planner.preview(planner.PlanRequest(
        model_id="qwen3-8b",
        backend="llama.cpp",
        port=8080,
        hardware={"source": "browser", "platform": "win32", "ram_gb": 32,
                  "gpus": [{"name": "NVIDIA GeForce RTX 3060", "vendor": "nvidia",
                            "vram_gb": 12, "uma": False}]},
    ))
    assert out["hardware_source"] == "client:browser"
    assert out["hardware"]["uma"] is False
    assert 9.5 < out["hardware"]["usable_vram_gb"] < 10.5
    assert out["command"][0] == "llama-server"
    # B-08 invariant: the planned window is capped by the model's native
    # context, never by the 64K floor. Compute it, do not hardcode a number.
    from app.services.catalog import CATALOG
    entry = next(e for e in CATALOG if e.id == "qwen3-8b")
    assert 1 <= out["decision"]["planned_window"] <= entry.native_ctx


def test_planner_uses_server_probe_without_profile():
    from app.services import planner

    out = planner.preview(planner.PlanRequest(model_id="qwen3-8b", backend="llama.cpp", port=8080))
    assert out["hardware_source"] == "server"


# --- cross-validation confidence (docs/probe-session-design.md section 6) -----

def test_confidence_values_are_the_frozen_enum():
    assert set(hardware.CONFIDENCE_VALUES) == {
        "verified", "measured", "disputed", "unverified", "confirmed",
    }


def test_confidence_verified_when_measured_matches_the_table():
    result = hardware.budget_from_profile({
        "source": "agent",
        "gpus": [{"name": "NVIDIA GeForce RTX 4090", "vendor": "nvidia",
                  "vram_gb": 24, "uma": False}],
    })
    assert result.confidence == "verified"
    assert result.to_dict()["confidence"] == "verified"


def test_confidence_measured_when_the_table_has_no_entry():
    result = hardware.budget_from_profile({
        "source": "agent",
        "gpus": [{"name": "Totally Unknown Accelerator 9999", "vendor": "unknown",
                  "vram_gb": 16, "uma": False}],
    })
    assert result.confidence == "measured"


def test_confidence_disputed_takes_measured_and_warns():
    result = hardware.budget_from_profile({
        "source": "agent",
        "gpus": [{"name": "NVIDIA GeForce RTX 4090", "vendor": "nvidia",
                  "vram_gb": 48, "uma": False}],
    })
    assert result.confidence == "disputed"
    assert "显存与型号标称不符（实测 48.0 GB / 查表 24.0 GB），请确认" in result.warnings
    # "取实测": the measured 48 GB is what the budget is priced against.
    assert result.budget.total_device_gb == 48.0


def test_confidence_unverified_for_a_browser_lookup_only():
    result = hardware.budget_from_profile({
        "source": "browser",
        "gpus": [{"name": "NVIDIA GeForce RTX 4090", "vendor": "nvidia",
                  "vram_gb": 24, "uma": False}],
    })
    assert result.confidence == "unverified"


def test_confidence_confirmed_marker_wins_and_suppresses_the_warning():
    result = hardware.budget_from_profile({
        "source": "agent",
        "confirmed": True,
        "gpus": [{"name": "NVIDIA GeForce RTX 4090", "vendor": "nvidia",
                  "vram_gb": 48, "uma": False}],
    })
    assert result.confidence == "confirmed"
    assert not any("显存与型号标称不符" in w for w in result.warnings)


def test_recommend_exposes_the_confidence_verdict():
    out = recommend(RecommendRequest(
        backend="ollama",
        hardware={"source": "agent", "ram_gb": 24,
                  "gpus": [{"name": "Apple M4", "vendor": "apple", "uma": True}]},
    ))
    assert out["confidence"] in hardware.CONFIDENCE_VALUES


# --- B-15: spill-visible must be reachable from a client profile / UMA --------

def test_spill_visible_is_reachable_for_a_client_uma_profile():
    """On UMA the hard refusal is the physical pool, not the planning budget.

    Before the fix physics_check used usable_vram for both the zero-spill gate
    and the hard refusal, so a model between the two was called impossible and
    spill-visible was unreachable.
    """
    from collections import Counter
    from app.services.catalog import resolve

    result = hardware.budget_from_profile({
        "source": "agent", "ram_gb": 24,
        "gpus": [{"name": "Apple M4", "vendor": "apple", "uma": True}],
    })
    choices = resolve(result.budget, backend="ollama")["choices"]
    keys = Counter(c.reason_key for c in choices)
    assert keys["spill-visible"] > 0, keys
    # The zero-spill invariant is untouched: a spilling row is never zero-spill.
    for choice in choices:
        if choice.zero_spill:
            assert choice.reason_key != "spill-visible"


def test_spill_visible_is_reachable_for_a_client_discrete_profile():
    """A client only reports total RAM, but that is still a physical ceiling."""
    from collections import Counter
    from app.services.catalog import resolve

    result = hardware.budget_from_profile({
        "source": "agent", "ram_gb": 32,
        "gpus": [{"name": "NVIDIA GeForce RTX 3060", "vendor": "nvidia",
                  "vram_gb": 12, "uma": False}],
    })
    choices = resolve(result.budget, backend="ollama")["choices"]
    keys = Counter(c.reason_key for c in choices)
    assert keys["spill-visible"] > 0, keys
    for choice in choices:
        if choice.zero_spill:
            assert choice.reason_key != "spill-visible"

