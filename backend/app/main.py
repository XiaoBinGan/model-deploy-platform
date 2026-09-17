from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles
from pathlib import Path
from pydantic import BaseModel
from .services import environment, models, planner, deployments
from .runtimes import ollama_runtime

app = FastAPI(title="Model Deploy Platform", version="0.2.0")

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
def create_deployment(req: DeployRequest):
    return deployments.create(
        model_path=req.model_path, model_id=req.model_id, backend=req.backend,
        port=req.port, dtype=req.dtype, quantization=req.quantization, model_name=req.model_name
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

@app.get("/api/backends")
def backends():
    return deployments.available_backends()

# Mount frontend
frontend_dir = Path(__file__).resolve().parents[1].parent / "frontend"
if frontend_dir.exists():
    app.mount("/", StaticFiles(directory=str(frontend_dir), html=True), name="frontend")
