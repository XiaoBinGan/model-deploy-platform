from fastapi import APIRouter
from pydantic import BaseModel, Field
router=APIRouter()
VARIANT_MEMORY={"qwen3-8b-bf16":18.0,"qwen3-8b-fp8":12.0,"qwen3-8b-awq":9.0,"qwen3-8b-gptq":9.0,"qwen3-4b-bf16":10.0,"qwen25-coder-7b-awq":8.5}
class PlanRequest(BaseModel):
    model_path:str="G:/models/Qwen3-8B"
    model_id:str="qwen3-8b-bf16"
    backend:str="vllm"
    port:int=8000
    dtype:str="bfloat16"
    quantization:str|None=None
    max_model_len:int=32768
    max_num_seqs:int=8
    gpu_memory_utilization:float=Field(.9,ge=.5,le=.99)
@router.post("/plans/preview")
def preview(req:PlanRequest):
    base=VARIANT_MEMORY.get(req.model_id,18 if "8b" in req.model_id else 10)
    estimated=round(base + req.max_model_len/32768*2 + req.max_num_seqs*.35,1)
    warnings=[]; status="PASS"
    if estimated>28: status="WARNING"; warnings.append("预计显存接近 32GB，请降低上下文或并发")
    if req.quantization=="bitsandbytes" and req.backend in {"vllm","sglang"}:
        status="BLOCKED"; warnings.append("vLLM/SGLang 不把 BitsAndBytes 作为通用的运行时量化方案，请使用预量化 AWQ/GPTQ/FP8 checkpoint")
    if req.backend=="vllm":
        cmd=["vllm","serve",req.model_path,"--host","127.0.0.1","--port",str(req.port),"--dtype",req.dtype,"--max-model-len",str(req.max_model_len),"--gpu-memory-utilization",str(req.gpu_memory_utilization),"--max-num-seqs",str(req.max_num_seqs)]
        if req.quantization in {"awq","gptq"}: cmd += ["--quantization",req.quantization]
    else:
        cmd=["python","-m","sglang.launch_server","--model-path",req.model_path,"--host","127.0.0.1","--port",str(req.port),"--dtype",req.dtype,"--context-length",str(req.max_model_len),"--mem-fraction-static",str(req.gpu_memory_utilization)]
        if req.quantization in {"awq","gptq"}: cmd += ["--quantization",req.quantization]
    return {"status":status,"estimated_memory_gb":estimated,"warnings":warnings,"command":cmd,"command_string":" ".join(cmd)}
