from app.services.models import recommend, RecommendRequest
from app.services.planner import preview, PlanRequest
from app.services.environment import scan


def test_environment_has_platform_fields():
    out = scan()
    assert "os" in out and "architecture" in out
    assert "apple_silicon" in out and "recommended_backends" in out


def test_recommendations_are_resolved_and_explained():
    out = recommend(RecommendRequest(task="chat", goal="balanced", available_vram_gb=16, backend="vllm"))
    assert out["mode"] == "resolver"
    assert out["reason_key"] in out["reason_keys"]
    for row in out["recommendations"]:
        assert row["reason_key"] in out["reason_keys"]
        # A row that does not fit is still visible, but never zero-spill.
        if not row["fits"]:
            assert row["zero_spill"] is False


def test_require_local_only_returns_ready_checkpoints():
    out = recommend(RecommendRequest(require_local=True, available_vram_gb=32))
    for row in out["recommendations"]:
        assert row["availability"] == "local_ready"


def test_plan_command_is_argument_list():
    out = preview(PlanRequest(model_id="qwen3-8b-awq", quantization="awq"))
    assert out["command"][0] == "vllm"
    assert "--quantization" in out["command"]


def test_llamacpp_command_derives_window_and_kv_quant():
    from app.services.catalog import CATALOG

    out = preview(PlanRequest(model_id="qwen3-8b", backend="llama.cpp", model_path="/models/qwen3-8b.gguf"))
    assert out["command"][0] == "llama-server"
    assert "-ctk" in out["command"] and "q8_0" in out["command"]
    # B-08: the window comes off the ladder but is capped by native_ctx, so it
    # can be below the 64K floor. R3-08: "1 <= window" was a vacuous lower
    # bound; assert the documented floor and that the cap actually binds.
    from app.services.estimator import FLOOR_WINDOW

    entry = next(e for e in CATALOG if e.id == "qwen3-8b")
    window = out["decision"]["planned_window"]
    assert 1024 <= window <= entry.native_ctx
    assert window == min(FLOOR_WINDOW, entry.native_ctx)


def test_bitsandbytes_is_blocked_for_vllm():
    out = preview(PlanRequest(quantization="bitsandbytes"))
    assert out["status"] == "BLOCKED"
