import json
import shutil
import subprocess
from pathlib import Path
from fastapi import APIRouter
from pydantic import BaseModel

router = APIRouter()
ROOTS = [Path("G:/models"), Path("/models")]

# Catalog entries describe candidates. They are not treated as locally ready
# until a real checkpoint is found and validated.
DEFAULT = [
    {"id":"qwen25-05b-instruct","base_model":"Qwen2.5-0.5B-Instruct","name":"Qwen2.5-0.5B-Instruct · BF16","parameters_b":0.5,"precision":"bf16","quantization":None,"memory_gb":1.2,"capabilities":["chat","chinese"],"context_length":32768,"backends":["vllm","sglang","transformers"],"availability":"catalog"},

    # 通用 / 中文
    {"id":"qwen3-8b-bf16","base_model":"Qwen3-8B","name":"Qwen3-8B · BF16","parameters_b":8,"precision":"bf16","quantization":None,"memory_gb":18.0,"capabilities":["chat","reasoning","tool_calling","chinese"],"context_length":32768,"backends":["vllm","sglang"],"source":{"huggingface":"Qwen/Qwen3-8B","modelscope":"Qwen/Qwen3-8B"}},
    {"id":"qwen3-8b-fp8","base_model":"Qwen3-8B","name":"Qwen3-8B · FP8","parameters_b":8,"precision":"fp8","quantization":"fp8","memory_gb":12.0,"capabilities":["chat","reasoning","tool_calling","chinese"],"context_length":32768,"backends":["vllm","sglang"],"source":{"huggingface":"Qwen/Qwen3-8B-FP8","modelscope":"Qwen/Qwen3-8B-FP8"}},
    {"id":"qwen3-8b-awq","base_model":"Qwen3-8B","name":"Qwen3-8B · AWQ INT4","parameters_b":8,"precision":"int4","quantization":"awq","memory_gb":9.0,"capabilities":["chat","reasoning","tool_calling","chinese"],"context_length":32768,"backends":["vllm","sglang"],"source":{"huggingface":"Qwen/Qwen3-8B-AWQ","modelscope":"Qwen/Qwen3-8B-AWQ"}},
    {"id":"qwen3-8b-gptq","base_model":"Qwen3-8B","name":"Qwen3-8B · GPTQ INT4","parameters_b":8,"precision":"int4","quantization":"gptq","memory_gb":9.0,"capabilities":["chat","reasoning","tool_calling","chinese"],"context_length":32768,"backends":["vllm","sglang"],"source":{"huggingface":"Qwen/Qwen3-8B-GPTQ","modelscope":"Qwen/Qwen3-8B-GPTQ"}},
    {"id":"qwen3-4b-bf16","base_model":"Qwen3-4B","name":"Qwen3-4B · BF16","parameters_b":4,"precision":"bf16","quantization":None,"memory_gb":10.0,"capabilities":["chat","reasoning","chinese"],"context_length":32768,"backends":["vllm","sglang"],"source":{"huggingface":"Qwen/Qwen3-4B","modelscope":"Qwen/Qwen3-4B"}},
    {"id":"qwen3-1.7b-bf16","base_model":"Qwen3-1.7B","name":"Qwen3-1.7B · BF16","parameters_b":1.7,"precision":"bf16","quantization":None,"memory_gb":4.5,"capabilities":["chat","reasoning","chinese"],"context_length":32768,"backends":["vllm","sglang"],"source":{"huggingface":"Qwen/Qwen3-1.7B","modelscope":"Qwen/Qwen3-1.7B"}},
    {"id":"qwen25-14b-awq","base_model":"Qwen2.5-14B-Instruct","name":"Qwen2.5-14B · AWQ INT4","parameters_b":14,"precision":"int4","quantization":"awq","memory_gb":15.5,"capabilities":["chat","chinese","tool_calling"],"context_length":32768,"backends":["vllm","sglang"],"source":{"huggingface":"Qwen/Qwen2.5-14B-Instruct-AWQ","modelscope":"Qwen/Qwen2.5-14B-Instruct-AWQ"}},
    {"id":"qwen25-32b-awq","base_model":"Qwen2.5-32B-Instruct","name":"Qwen2.5-32B · AWQ INT4","parameters_b":32,"precision":"int4","quantization":"awq","memory_gb":22.0,"capabilities":["chat","chinese","tool_calling","long_context"],"context_length":32768,"backends":["vllm","sglang"],"source":{"huggingface":"Qwen/Qwen2.5-32B-Instruct-AWQ","modelscope":"Qwen/Qwen2.5-32B-Instruct-AWQ"}},
    # 代码 / 推理
    {"id":"qwen25-coder-7b-bf16","base_model":"Qwen2.5-Coder-7B-Instruct","name":"Qwen2.5-Coder-7B · BF16","parameters_b":7,"precision":"bf16","quantization":None,"memory_gb":16.0,"capabilities":["code","chat","chinese"],"context_length":32768,"backends":["vllm","sglang"],"source":{"huggingface":"Qwen/Qwen2.5-Coder-7B-Instruct","modelscope":"Qwen/Qwen2.5-Coder-7B-Instruct"}},
    {"id":"qwen25-coder-7b-awq","base_model":"Qwen2.5-Coder-7B-Instruct","name":"Qwen2.5-Coder-7B · AWQ INT4","parameters_b":7,"precision":"int4","quantization":"awq","memory_gb":8.5,"capabilities":["code","chat","chinese"],"context_length":32768,"backends":["vllm","sglang"],"source":{"huggingface":"Qwen/Qwen2.5-Coder-7B-Instruct-AWQ","modelscope":"Qwen/Qwen2.5-Coder-7B-Instruct-AWQ"}},
    {"id":"deepseek-r1-distill-qwen-7b","base_model":"DeepSeek-R1-Distill-Qwen-7B","name":"DeepSeek-R1-Distill-Qwen-7B · BF16","parameters_b":7,"precision":"bf16","quantization":None,"memory_gb":16.0,"capabilities":["reasoning","chat","chinese"],"context_length":32768,"backends":["vllm","sglang"],"source":{"huggingface":"deepseek-ai/DeepSeek-R1-Distill-Qwen-7B","modelscope":"deepseek-ai/DeepSeek-R1-Distill-Qwen-7B"}},
    {"id":"deepseek-r1-distill-qwen-14b-awq","base_model":"DeepSeek-R1-Distill-Qwen-14B","name":"DeepSeek-R1-Distill-Qwen-14B · AWQ INT4","parameters_b":14,"precision":"int4","quantization":"awq","memory_gb":15.5,"capabilities":["reasoning","chat","chinese"],"context_length":32768,"backends":["vllm","sglang"],"source":{"huggingface":"Valdemardi/DeepSeek-R1-Distill-Qwen-14B-AWQ","modelscope":"deepseek-ai/DeepSeek-R1-Distill-Qwen-14B"}},
    # 国际通用模型
    {"id":"llama-3.1-8b-bf16","base_model":"Llama-3.1-8B-Instruct","name":"Llama 3.1 8B · BF16","parameters_b":8,"precision":"bf16","quantization":None,"memory_gb":18.0,"capabilities":["chat","tool_calling","english"],"context_length":131072,"backends":["vllm","sglang"],"source":{"huggingface":"meta-llama/Llama-3.1-8B-Instruct","modelscope":"LLM-Research/Meta-Llama-3.1-8B-Instruct"}},
    {"id":"mistral-7b-awq","base_model":"Mistral-7B-Instruct-v0.3","name":"Mistral 7B · AWQ INT4","parameters_b":7,"precision":"int4","quantization":"awq","memory_gb":8.5,"capabilities":["chat","english","code"],"context_length":32768,"backends":["vllm","sglang"],"source":{"huggingface":"TheBloke/Mistral-7B-Instruct-v0.3-AWQ","modelscope":"AI-ModelScope/Mistral-7B-Instruct-v0.3-AWQ"}},
    {"id":"gemma-3-4b-bf16","base_model":"Gemma-3-4B-it","name":"Gemma 3 4B · BF16","parameters_b":4,"precision":"bf16","quantization":None,"memory_gb":10.0,"capabilities":["chat","vision","english"],"context_length":131072,"backends":["vllm","sglang"],"source":{"huggingface":"google/gemma-3-4b-it","modelscope":"google/gemma-3-4b-it"}},
    {"id":"phi-4-mini-bf16","base_model":"Phi-4-mini-instruct","name":"Phi-4-mini · BF16","parameters_b":3.8,"precision":"bf16","quantization":None,"memory_gb":9.5,"capabilities":["chat","code","english","reasoning"],"context_length":131072,"backends":["vllm","sglang"],"source":{"huggingface":"microsoft/Phi-4-mini-instruct","modelscope":"AI-ModelScope/Phi-4-mini-instruct"}},
    {"id":"internlm3-8b-bf16","base_model":"InternLM3-8B-Instruct","name":"InternLM3 8B · BF16","parameters_b":8,"precision":"bf16","quantization":None,"memory_gb":18.0,"capabilities":["chat","reasoning","chinese","code"],"context_length":32768,"backends":["vllm","sglang"],"source":{"huggingface":"internlm/internlm3-8b-instruct","modelscope":"Shanghai_AI_Laboratory/internlm3-8b-instruct"}},
    # 视觉
    {"id":"qwen2.5-vl-7b-bf16","base_model":"Qwen2.5-VL-7B-Instruct","name":"Qwen2.5-VL-7B · BF16","parameters_b":7,"precision":"bf16","quantization":None,"memory_gb":18.0,"capabilities":["chat","vision","chinese"],"context_length":32768,"backends":["vllm","sglang"],"source":{"huggingface":"Qwen/Qwen2.5-VL-7B-Instruct","modelscope":"Qwen/Qwen2.5-VL-7B-Instruct"}},
    {"id":"qwen2.5-vl-7b-awq","base_model":"Qwen2.5-VL-7B-Instruct","name":"Qwen2.5-VL-7B · AWQ INT4","parameters_b":7,"precision":"int4","quantization":"awq","memory_gb":11.0,"capabilities":["chat","vision","chinese"],"context_length":32768,"backends":["vllm","sglang"],"source":{"huggingface":"Qwen/Qwen2.5-VL-7B-Instruct-AWQ","modelscope":"Qwen/Qwen2.5-VL-7B-Instruct-AWQ"}},
]


class RecommendRequest(BaseModel):
    task: str = "chat"
    goal: str = "balanced"  # balanced, quality, low-memory, throughput, low-latency
    concurrency: int = 4
    available_vram_gb: float | None = None
    backend: str = "vllm"
    prefer_quantized: bool | None = None
    require_local: bool = False


def _command(args):
    try:
        p=subprocess.run(args, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=5)
        return p.stdout.strip()
    except Exception:
        return ""


def _environment():
    out=_command(["nvidia-smi","--query-gpu=memory.total,memory.free","--format=csv,noheader,nounits"])
    if not out:
        return None, None
    parts=[x.strip() for x in out.splitlines()[0].split(",")]
    if len(parts)<2:
        return None, None
    return float(parts[0])/1024, float(parts[1])/1024


def scan_models():
    result=[]
    for root in ROOTS:
        if not root.exists():
            continue
        for cfg in root.rglob("config.json"):
            try:
                data=json.loads(cfg.read_text(encoding="utf-8"))
                weights=list(cfg.parent.glob("*.safetensors"))+list(cfg.parent.glob("*.bin"))
                total=sum(x.stat().st_size for x in weights)/1024**3
                result.append({"id":cfg.parent.name,"name":cfg.parent.name,"path":str(cfg.parent),"architecture":data.get("architectures",["unknown"])[0],"context_length":data.get("max_position_embeddings",0),"weight_size_gb":round(total,2),"quantization":data.get("quantization_config",{}).get("quant_method"),"status":"READY" if weights else "PARTIAL"})
            except Exception:
                pass
    return result


def _availability(model, local_models):
    # Exact local match wins. Catalog-only candidates require download and are
    # never described as ready-to-run.
    exact=[x for x in local_models if x["id"].lower() == model["base_model"].lower() or x["id"].lower() == model["id"].lower()]
    if exact and any(x["status"] == "READY" for x in exact):
        return "local_ready", exact[0].get("path")
    return "download_required", None


@router.get("/models/catalog")
def catalog():
    return {"models": DEFAULT, "quantization_policy": {"vllm_sglang": ["bf16", "fp8", "awq", "gptq"], "transformers_only": ["bitsandbytes"]}}

@router.get("/models/local")
def local():
    return {"models":scan_models()}

@router.post("/models/recommend")
def recommend(req: RecommendRequest):
    total_vram, free_vram = _environment()
    available = req.available_vram_gb or free_vram or total_vram
    local_models=scan_models()
    candidates=[]
    excluded=[]
    for model in DEFAULT:
        if req.backend not in model["backends"]:
            excluded.append({"id":model["id"],"reason":"后端不兼容"})
            continue
        availability, local_path=_availability(model, local_models)
        if req.require_local and availability != "local_ready":
            excluded.append({"id":model["id"],"reason":"本地没有完整 checkpoint"})
            continue
        # Reserve 15% for runtime/KV/fragmentation. This is a feasibility gate,
        # not a score penalty: an impossible model must not rank first.
        fits = available is None or model["memory_gb"] <= available * 0.85
        if not fits:
            excluded.append({"id":model["id"],"reason":f"预计 {model['memory_gb']}GB，超过安全预算 {round((available or 0)*.85,1)}GB"})
            continue
        score=0
        reasons=[]
        if req.task in model["capabilities"]:
            score += 40; reasons.append("任务匹配")
        else:
            score -= 25
        # Quality/balanced: prefer the largest fitting model, BF16 before quant.
        # Low-memory/throughput: prefer quantized variants, then largest model.
        if req.goal == "quality":
            # Quality explicitly trades VRAM for the largest feasible model.
            score += model["parameters_b"] * 5
            score += 18 if model["quantization"] is None else 0
            if model["quantization"] is None: reasons.append("质量模式优先保留 BF16 精度")
        elif req.goal == "balanced":
            # Balanced is not "largest that fits": avoid recommending a 32B
            # INT4 checkpoint over a stable 7B/8B BF16 default. Prefer the
            # 4B-14B operating band, native precision, and common families.
            band_bonus = 24 if 4 <= model["parameters_b"] <= 14 else 4
            precision_bonus = 20 if model["quantization"] is None else 0
            score += band_bonus + precision_bonus + min(model["parameters_b"], 14) * 2
            if model["quantization"] is None: reasons.append("平衡模式优先原生精度")
            if 4 <= model["parameters_b"] <= 14: reasons.append("规模处于通用部署甜点区")
        elif req.goal == "low-memory":
            score += 24 if model["quantization"] in {"awq","gptq"} else 8 if model["quantization"] == "fp8" else 0
            score += model["parameters_b"] * 5
            if model["quantization"]: reasons.append(f"符合{model['quantization'].upper()}低显存策略")
        elif req.goal == "throughput":
            score += 28 if model["quantization"] == "fp8" else 18 if model["quantization"] in {"awq","gptq"} else 0
            score += min(req.concurrency,16)
            if model["quantization"]: reasons.append("量化权重降低显存压力，适合吞吐目标")
        else:
            score += model["parameters_b"] * 4
        if req.prefer_quantized is True:
            score += 20 if model["quantization"] else -12
        if req.prefer_quantized is False and model["quantization"]:
            score -= 15
        if availability == "local_ready":
            score += 30; reasons.append("本地 checkpoint 已就绪")
        else:
            reasons.append("本地未发现，将在部署前下载并校验")
        candidates.append({**model,"score":round(max(0,score),1),"availability":availability,"local_path":local_path,"source_status":"local_ready" if availability == "local_ready" else "remote_unverified","reasons":reasons,"reason":"；".join(reasons)})
    candidates.sort(key=lambda x:(x["score"],x["parameters_b"]), reverse=True)
    return {"mode":"rule","hardware":{"total_vram_gb":total_vram,"free_vram_gb":free_vram,"budget_gb":round(available*.85,1) if available else None},"recommendations":candidates[:5],"excluded":excluded,"selection_policy":{"quantized_considered":True,"hard_memory_gate":True,"note":"balanced/quality 优先可容纳的 BF16；low-memory/throughput 优先已验证或可下载的 FP8/AWQ/GPTQ。不存在本地 checkpoint 时标记 download_required，不伪装为 READY。"}}
