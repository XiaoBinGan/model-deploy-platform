import os, platform, shutil, subprocess
from fastapi import APIRouter
router=APIRouter()

def run(args):
    try:
        p=subprocess.run(args, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=8)
        return p.stdout.strip() if p.returncode==0 else ""
    except Exception: return ""

def _sysctl(name):
    value=run(["sysctl","-n",name])
    try: return int(value)
    except (TypeError,ValueError): return None

def scan():
    system=platform.system(); architecture=platform.machine(); gpu=[]
    out=run(["nvidia-smi","--query-gpu=name,memory.total,memory.free,driver_version","--format=csv,noheader,nounits"])
    for i,line in enumerate(out.splitlines()):
        parts=[x.strip() for x in line.split(",")]
        if len(parts)>=4: gpu.append({"index":i,"name":parts[0],"memory_total_mb":int(float(parts[1])),"memory_free_mb":int(float(parts[2])),"driver_version":parts[3],"memory_type":"dedicated"})
    apple_silicon=system=="Darwin" and architecture in {"arm64","aarch64"}
    memory_total=_sysctl("hw.memsize") if apple_silicon else None
    memory_total_gb=round(memory_total/1024**3,1) if memory_total else None
    if apple_silicon:
        gpu=[{"index":0,"name":"Apple Silicon GPU (Metal)","memory_total_mb":int(memory_total/1024**2) if memory_total else None,"memory_free_mb":None,"driver_version":"Metal","memory_type":"unified"}]
    docker=bool(shutil.which("docker")); wsl=bool(shutil.which("wsl"))
    checks=[{"name":"GPU","status":"PASS" if gpu else "WARNING","message":"检测到 Apple Silicon GPU，可使用统一内存" if apple_silicon else ("检测到 NVIDIA GPU" if gpu else "未检测到可用 GPU")},{"name":"Docker","status":"PASS" if docker else "UNKNOWN","message":"Docker 可用" if docker else "未安装 Docker"}]
    if apple_silicon:
        checks += [{"name":"Metal","status":"PASS","message":"Apple Metal 可用；GPU 与 CPU 共用统一内存"},{"name":"CUDA","status":"NOT_APPLICABLE","message":"Apple Silicon 不使用 CUDA/nvidia-smi"}]
    else: checks += [{"name":"WSL2","status":"PASS" if wsl else "UNKNOWN","message":"WSL 可用" if wsl else "未检测到 WSL"}]
    return {"os":system,"architecture":architecture,"python":platform.python_version(),"cpu_cores":os.cpu_count(),"gpu":gpu,"apple_silicon":apple_silicon,"memory":{"total_gb":memory_total_gb,"type":"unified" if apple_silicon else "unknown"},"docker":{"installed":docker},"wsl2":{"installed":wsl},"recommended_backends":["ollama","transformers"] if apple_silicon else ["vllm","sglang","ollama","transformers"],"status":"PASS" if gpu else "WARNING","checks":checks}

@router.post("/environment/scan")
def environment_scan(): return scan()
@router.get("/environment/latest")
def environment_latest(): return scan()
