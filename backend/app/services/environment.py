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

def is_apple_silicon(system=None, architecture=None):
    """True on Apple Silicon: Metal/unified memory, no discrete VRAM, no CUDA.

    Shared with planner so the two modules cannot disagree about what a Mac is.
    """
    system = system if system is not None else platform.system()
    architecture = architecture if architecture is not None else platform.machine()
    return system == "Darwin" and architecture in {"arm64","aarch64"}

def nvidia_devices():
    """Parse `nvidia-smi` into device dicts.

    A malformed row (a CUDA warning mixed into the output, a driver that changes
    the column format) must not take the whole GPU block down with it. Each row
    is validated on its own; bad rows are skipped, not fatal. This is B-23 in
    docs/qa-findings-backend.md: hardware._nvidia_devices already did this,
    environment.scan did not.
    """
    out=run(["nvidia-smi","--query-gpu=name,memory.total,memory.free,driver_version","--format=csv,noheader,nounits"])
    gpu=[]
    for line in out.splitlines():
        parts=[x.strip() for x in line.split(",")]
        if len(parts)<4: continue
        try:
            total_mb=int(float(parts[1])); free_mb=int(float(parts[2]))
        except (TypeError,ValueError): continue
        gpu.append({"index":len(gpu),"name":parts[0],"memory_total_mb":total_mb,"memory_free_mb":free_mb,"driver_version":parts[3],"memory_type":"dedicated"})
    return gpu

def scan():
    system=platform.system(); architecture=platform.machine(); gpu=nvidia_devices()
    apple_silicon=is_apple_silicon(system, architecture)
    memory_total=_sysctl("hw.memsize") if apple_silicon else None
    memory_total_gb=round(memory_total/1024**3,1) if memory_total else None
    if apple_silicon:
        gpu=[{"index":0,"name":"Apple Silicon GPU (Metal)","memory_total_mb":int(memory_total/1024**2) if memory_total else None,"memory_free_mb":None,"driver_version":"Metal","memory_type":"unified"}]
    # shutil.which only proves the docker CLI is on PATH. It says nothing about
    # whether the daemon is alive, and this endpoint does not pretend otherwise:
    # probing the daemon would need a real docker call we do not make here.
    docker_cli=bool(shutil.which("docker")); wsl=bool(shutil.which("wsl"))
    docker_check={"name":"Docker","status":"PASS" if docker_cli else "UNKNOWN","message":"PATH 中有 docker 命令（未探测守护进程是否运行）" if docker_cli else "未安装 docker 命令"}
    checks=[{"name":"GPU","status":"PASS" if gpu else "WARNING","message":"检测到 Apple Silicon GPU，可使用统一内存" if apple_silicon else ("检测到 NVIDIA GPU" if gpu else "未检测到可用 GPU")},docker_check]
    if apple_silicon:
        checks += [{"name":"Metal","status":"PASS","message":"Apple Metal 可用；GPU 与 CPU 共用统一内存"},{"name":"MLX","status":"UNKNOWN","message":"Apple Silicon 的高吞吐本地推理路径（pip install mlx-lm）"},{"name":"CUDA","status":"NOT_APPLICABLE","message":"Apple Silicon 不使用 CUDA/nvidia-smi"}]
    else: checks += [{"name":"WSL2","status":"PASS" if wsl else "UNKNOWN","message":"WSL 可用" if wsl else "未检测到 WSL"}]
    recommended=["ollama","mlx"] if apple_silicon else ["vllm","sglang","ollama","transformers"]
    # "可用" here means the CLI exists; the contract's daemon check is a desktop
    # concern, so the recommendation stays honest via the Docker check message.
    if docker_cli: recommended.append("docker")
    return {"os":system,"architecture":architecture,"python":platform.python_version(),"cpu_cores":os.cpu_count(),"gpu":gpu,"apple_silicon":apple_silicon,"memory":{"total_gb":memory_total_gb,"type":"unified" if apple_silicon else "unknown"},"docker":{"installed":docker_cli,"cli":docker_cli,"daemon":"unknown"},"wsl2":{"installed":wsl},"recommended_backends":recommended,"status":"PASS" if gpu else "WARNING","checks":checks}

@router.post("/environment/scan")
def environment_scan(): return scan()
@router.get("/environment/latest")
def environment_latest(): return scan()
