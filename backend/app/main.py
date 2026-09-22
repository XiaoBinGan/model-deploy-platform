import os
import socket
import subprocess
from functools import lru_cache

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import PlainTextResponse
from fastapi.staticfiles import StaticFiles
from pathlib import Path
from pydantic import BaseModel

from .services import environment, models, planner, deployments, hardware, profiles, gpu_table
from .runtimes import ollama_runtime

app = FastAPI(title="Model Deploy Platform", version="0.2.0")

# LAN control plane: allow other machines on the network to call the API.
# This is an unauthenticated control plane, so only expose it on trusted nets.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# A shared service must not deploy to itself on behalf of a remote user: the
# model would land on the server, not on their machine. Off by default; an
# operator can opt in for a trusted single-tenant box.
ALLOW_REMOTE_DEPLOY = os.environ.get("MDP_ALLOW_REMOTE_DEPLOY", "0") == "1"

LOOPBACK = {"127.0.0.1", "::1", "localhost", "::ffff:127.0.0.1"}


@lru_cache(maxsize=1)
def _local_addresses() -> frozenset:
    """This host's own interface addresses, so "same machine via LAN IP" still
    counts as local and is allowed to deploy.

    Interface enumeration is done locally (ifconfig / ip). DNS-based lookups
    are avoided on purpose: on a machine whose hostname does not resolve they
    block for tens of seconds, which would stall the first request.
    """
    addresses = {"127.0.0.1", "::1"}
    try:
        probe = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        probe.connect(("8.8.8.8", 80))
        addresses.add(probe.getsockname()[0])
        probe.close()
    except Exception:
        pass
    for command in (["ifconfig"], ["ip", "-o", "addr"]):
        try:
            out = subprocess.run(command, capture_output=True, text=True, timeout=3).stdout
        except Exception:
            continue
        for line in out.splitlines():
            parts = line.split()
            for index, token in enumerate(parts):
                if token == "inet" and index + 1 < len(parts):
                    addresses.add(parts[index + 1].split("/")[0])
        if len(addresses) > 2:
            break
    return frozenset(addresses)


def _client_is_local(request: Request) -> bool:
    host = request.client.host if request.client else ""
    return host in LOOPBACK or host in _local_addresses()


def _public_host(request: Request) -> str:
    """Host a remote caller should use, derived from the request itself."""
    host = request.headers.get("host") or request.url.hostname or "127.0.0.1"
    return host.split(":")[0]


def _base_url(request: Request) -> str:
    return str(request.base_url).rstrip("/")


@app.get("/api/health")
def health():
    return {
        "status": "ok",
        "service": "model-deploy-platform",
        "version": "0.2.0",
        "allow_remote_deploy": ALLOW_REMOTE_DEPLOY,
    }

@app.get("/api/environment/latest")
def env_latest():
    return environment.scan()

@app.get("/api/environment/scan")
def env_scan():
    return environment.scan()

@app.get("/api/models/catalog")
def catalog():
    return models.catalog()

@app.get("/api/models/local")
def local_models():
    return models.local()

@app.get("/api/models/ollama")
def ollama_models():
    return {"models": ollama_runtime.list_models()}

@app.post("/api/models/recommend")
def recommend(req: models.RecommendRequest, request: Request):
    req.client_is_local = _client_is_local(request)
    return models.recommend(req)

@app.post("/api/plans/preview")
def plan_preview(req: planner.PlanRequest):
    return planner.preview(req)


# --- client hardware -------------------------------------------------------

@app.get("/api/hardware/self")
def hardware_self():
    budget = hardware.probe_budget(planning=True)
    data = budget.to_dict()
    data["source"] = "server"
    data["trusted"] = True
    data["note"] = "这是服务器自身的硬件，不代表远端客户端"
    return data

@app.get("/api/hardware/gpus")
def hardware_gpus():
    return {"gpus": gpu_table.table(), "note": "浏览器读不到显存，只能按型号查表"}

class HardwareProfile(BaseModel):
    source: str = "manual"
    platform: str | None = None
    architecture: str | None = None
    cpu_cores: int | None = None
    ram_gb: float | None = None
    gpus: list[dict] | None = None
    disk_free_gb: float | None = None

class ResolveRequest(BaseModel):
    hardware: HardwareProfile

class ParseRequest(BaseModel):
    text: str

@app.post("/api/hardware/resolve")
def hardware_resolve(req: ResolveRequest):
    result = hardware.budget_from_profile(req.hardware.model_dump())
    return result.to_dict()

@app.post("/api/hardware/parse")
def hardware_parse(req: ParseRequest):
    try:
        profile = profiles.parse_profile_input(req.text)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    result = hardware.budget_from_profile(profile)
    payload = result.to_dict()
    payload["profile"] = profile
    return payload

class ProfileCodeRequest(BaseModel):
    profile: dict

@app.post("/api/hardware/profile-code")
def hardware_profile_code(req: ProfileCodeRequest):
    return {"code": profiles.encode_profile(req.profile)}

@app.get("/api/hardware/probe.py", response_class=PlainTextResponse)
def hardware_probe_script():
    return PlainTextResponse(profiles.probe_script(), media_type="text/x-python")

@app.get("/api/hardware/probe-command")
def hardware_probe_command(request: Request):
    return {
        "command": profiles.probe_command(_base_url(request)),
        "platform": request.headers.get("user-agent", ""),
        "note": "在本机执行后把 JSON 或档案码粘回页面",
    }


# --- deployments -----------------------------------------------------------

class DeployRequest(BaseModel):
    model_path: str
    model_id: str = "custom"
    backend: str | None = None
    port: int = 8000
    dtype: str = "bfloat16"
    quantization: str | None = None
    model_name: str | None = None

@app.post("/api/deployments")
def create_deployment(req: DeployRequest, request: Request):
    if not _client_is_local(request) and not ALLOW_REMOTE_DEPLOY:
        raise HTTPException(
            status_code=403,
            detail="远端客户端不允许在服务器上创建部署：模型会部署到服务器，而不是你的机器。"
                   "请在本机执行参数预览给出的命令；若确需放开，设置 MDP_ALLOW_REMOTE_DEPLOY=1。",
        )
    return deployments.create(
        model_path=req.model_path, model_id=req.model_id, backend=req.backend,
        port=req.port, dtype=req.dtype, quantization=req.quantization, model_name=req.model_name,
        public_host=_public_host(request),
    )

@app.post("/api/deployments/{dep_id}/start")
def start_deployment(dep_id: str):
    return deployments.start(dep_id)

@app.post("/api/deployments/{dep_id}/stop")
def stop_deployment(dep_id: str):
    return deployments.stop(dep_id)

@app.get("/api/deployments")
def list_deployments():
    return {"deployments": deployments.list_all()}

@app.get("/api/deployments/{dep_id}")
def get_deployment(dep_id: str):
    return deployments.get(dep_id)

@app.get("/api/deployments/{dep_id}/health")
def deployment_health(dep_id: str):
    return deployments.health(dep_id)

class DeploymentTestRequest(BaseModel):
    message: str = "你好，请用一句话介绍你自己"
    model_name: str | None = None
    max_tokens: int = 512

@app.post("/api/deployments/{dep_id}/test")
def deployment_test(dep_id: str, req: DeploymentTestRequest):
    return deployments.test_chat(dep_id, req.message, req.model_name, req.max_tokens)

@app.get("/api/backends")
def backends():
    payload = deployments.available_backends()
    payload["allow_remote_deploy"] = ALLOW_REMOTE_DEPLOY
    return payload

# Mount frontend
frontend_dir = Path(__file__).resolve().parents[1].parent / "frontend"
if frontend_dir.exists():
    app.mount("/", StaticFiles(directory=str(frontend_dir), html=True), name="frontend")
