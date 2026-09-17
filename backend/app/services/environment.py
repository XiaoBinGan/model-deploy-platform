import os, platform, shutil, subprocess
from pathlib import Path
from fastapi import APIRouter
router=APIRouter()

def run(args):
    try:
        p=subprocess.run(args, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=8)
        return p.stdout.strip() if p.returncode==0 else ""
    except Exception: return ""

def scan():
    gpu=[]
    out=run(["nvidia-smi","--query-gpu=name,memory.total,memory.free,driver_version","--format=csv,noheader,nounits"])
    for i,line in enumerate(out.splitlines()):
        parts=[x.strip() for x in line.split(",")]
        if len(parts)>=4: gpu.append({"index":i,"name":parts[0],"memory_total_mb":int(float(parts[1])),"memory_free_mb":int(float(parts[2])),"driver_version":parts[3]})
    docker=bool(shutil.which("docker")); wsl=bool(shutil.which("wsl"))
    return {"os":platform.system(),"architecture":platform.machine(),"python":platform.python_version(),"cpu_cores":os.cpu_count(),"gpu":gpu,"docker":{"installed":docker},"wsl2":{"installed":wsl},"status":"PASS" if gpu else "WARNING","checks":[{"name":"GPU","status":"PASS" if gpu else "WARNING","message":"检测到 GPU" if gpu else "未检测到 nvidia-smi"},{"name":"Docker","status":"PASS" if docker else "UNKNOWN","message":"Docker 可用" if docker else "未安装 Docker"},{"name":"WSL2","status":"PASS" if wsl else "UNKNOWN","message":"WSL 可用" if wsl else "未检测到 WSL"}]}

@router.post("/environment/scan")
def environment_scan(): return scan()
@router.get("/environment/latest")
def environment_latest(): return scan()
