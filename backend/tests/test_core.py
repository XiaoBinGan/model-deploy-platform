from app.services.models import recommend, RecommendRequest
from app.services.planner import preview, PlanRequest

def test_low_memory_is_not_allowed_to_rank_impossible_model():
    out=recommend(RecommendRequest(task="chat",goal="low-memory",available_vram_gb=16,backend="vllm"))
    assert out["recommendations"]
    assert all(x["memory_gb"] <= 13.6 for x in out["recommendations"])
    assert any(x["quantization"] in {"fp8","awq","gptq"} for x in out["recommendations"])

def test_require_local_excludes_catalog_only_models():
    out=recommend(RecommendRequest(require_local=True,available_vram_gb=32))
    assert out["recommendations"] == []
    assert out["excluded"]

def test_plan_command_is_argument_list():
    out=preview(PlanRequest(model_id="qwen3-8b-awq",quantization="awq"))
    assert out["command"][0] == "vllm"
    assert "--quantization" in out["command"]

def test_bitsandbytes_is_blocked_for_vllm():
    out=preview(PlanRequest(quantization="bitsandbytes"))
    assert out["status"] == "BLOCKED"
