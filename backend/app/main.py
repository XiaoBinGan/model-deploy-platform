from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pathlib import Path
from pydantic import BaseModel
from .services import environment, models, planner, deployments
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


def _public_host(request: Request) -> str:
    """Host a remote caller should use, derived from the request itself."""
    host = request.headers.get("host") or request.url.hostname or "127.0.0.1"
    return host.split(":")[0]


@app.get("/api/health")
def health():
    return {"status": "ok", "service": "model-deploy-platform", "version": "0.2.0"}

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
def recommend(req: models.RecommendRequest):
    return models.recommend(req)

@app.post("/api/plans/preview")
def plan_preview(req: planner.PlanRequest):
    return planner.preview(req)

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
    max_tokens: int = 128

@app.post("/api/deployments/{dep_id}/test")
def deployment_test(dep_id: str, req: DeploymentTestRequest):
    return deployments.test_chat(dep_id, req.message, req.model_name, req.max_tokens)

@app.get("/api/backends")
def backends():
    return deployments.available_backends()

# Mount frontend
frontend_dir = Path(__file__).resolve().parents[1].parent / "frontend"
if frontend_dir.exists():
    app.mount("/", StaticFiles(directory=str(frontend_dir), html=True), name="frontend")
