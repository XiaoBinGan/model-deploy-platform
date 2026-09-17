"""Deployment service — manages model deployments via available runtimes."""
import subprocess, sys, time, os, signal, json
from pathlib import Path
import httpx

DEPLOYMENTS = {}

def _detect_backends() -> list[str]:
    """Find all available runtime backends."""
    backends = []
    # Check Ollama
    try:
        r = httpx.get("http://127.0.0.1:11434/api/tags", timeout=3)
        if r.status_code == 200:
            backends.append("ollama")
    except Exception:
        pass
    # Check vLLM
    try:
        import importlib
        if importlib.util.find_spec("vllm"):
            backends.append("vllm")
    except Exception:
        pass
    # Check SGLang
    try:
        import importlib
        if importlib.util.find_spec("sglang"):
            backends.append("sglang")
    except Exception:
        pass
    # Check transformers (always available if torch installed)
    try:
        import importlib
        if importlib.util.find_spec("torch") and importlib.util.find_spec("transformers"):
            backends.append("transformers")
    except Exception:
        pass
    return backends

def available_backends() -> dict:
    return {"backends": _detect_backends()}

def create(model_path: str, model_id: str, backend: str | None = None, port: int = 8000, dtype: str = "bfloat16", quantization: str | None = None, model_name: str | None = None) -> dict:
    dep_id = f"dep_{int(time.time())}"
    detected = _detect_backends()
    actual_backend = backend or (detected[0] if detected else "transformers")

    # For ollama, use the Ollama API port directly
    if actual_backend == "ollama":
        port = 11434
        model_path = model_name or model_id

    deployment = {
        "id": dep_id,
        "model_path": model_path,
        "model_id": model_id,
        "backend": actual_backend,
        "port": port,
        "host": "127.0.0.1",
        "dtype": dtype,
        "quantization": quantization,
        "status": "CREATED",
        "pid": None,
        "endpoint": f"http://127.0.0.1:{port}/v1",
        "health_endpoint": f"http://127.0.0.1:{port}/health" if actual_backend != "ollama" else f"http://127.0.0.1:{port}/api/tags",
        "created_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "log": [],
    }
    DEPLOYMENTS[dep_id] = deployment
    return deployment

def start(deployment_id: str) -> dict:
    dep = DEPLOYMENTS.get(deployment_id)
    if not dep:
        raise ValueError(f"Deployment {deployment_id} not found")

    if dep["backend"] == "ollama":
        # Ollama is already running; just preload the model
        try:
            r = httpx.post(
                f"http://127.0.0.1:{dep['port']}/api/generate",
                json={"model": dep["model_path"], "prompt": "", "stream": False, "keep_alive": "30m"},
                timeout=120,
            )
            if r.status_code == 200:
                dep["status"] = "RUNNING"
                dep["log"].append(f"Model {dep['model_path']} loaded into Ollama")
            else:
                dep["status"] = "FAILED"
                dep["log"].append(f"Ollama returned {r.status_code}: {r.text[:200]}")
        except Exception as e:
            dep["status"] = "FAILED"
            dep["log"].append(f"Ollama start error: {e}")

    elif dep["backend"] == "transformers":
        backend_dir = Path(__file__).resolve().parents[1]
        cmd = [
            sys.executable, "-m", "app.runtimes.transformers_server",
            "--model-path", dep["model_path"],
            "--port", str(dep["port"]),
            "--host", dep["host"],
            "--dtype", dep["dtype"],
        ]
        dep["status"] = "STARTING"
        proc = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            env={**os.environ, "PYTHONUNBUFFERED": "1"},
            cwd=str(backend_dir),
        )
        dep["pid"] = proc.pid
        for i in range(60):
            line = proc.stdout.readline()
            if line:
                dep["log"].append(line.decode("utf-8", errors="replace").rstrip())
            try:
                r = httpx.get(f"http://{dep['host']}:{dep['port']}/health", timeout=1)
                if r.status_code == 200:
                    dep["status"] = "RUNNING"
                    break
            except Exception:
                time.sleep(1)
        else:
            dep["status"] = "FAILED"

    elif dep["backend"] in ("vllm", "sglang"):
        dep["status"] = "BLOCKED"
        dep["log"].append(f"{dep['backend']} is not installed on this host")
    else:
        dep["status"] = "BLOCKED"
        dep["log"].append(f"Unknown backend: {dep['backend']}")

    return dep

def stop(deployment_id: str) -> dict:
    dep = DEPLOYMENTS.get(deployment_id)
    if not dep:
        raise ValueError(f"Deployment {deployment_id} not found")
    if dep.get("pid"):
        try:
            os.kill(dep["pid"], signal.SIGTERM)
            time.sleep(1)
        except Exception as e:
            dep["log"].append(f"stop error: {e}")
    # For ollama, unload model from memory
    if dep["backend"] == "ollama":
        try:
            httpx.post(
                f"http://127.0.0.1:{dep['port']}/api/generate",
                json={"model": dep["model_path"], "keep_alive": "0"},
                timeout=10,
            )
            dep["log"].append(f"Model {dep['model_path']} unloaded from Ollama")
        except Exception:
            pass
    dep["status"] = "STOPPED"
    return dep

def get(deployment_id: str) -> dict:
    return DEPLOYMENTS.get(deployment_id, {})

def list_all() -> list[dict]:
    return list(DEPLOYMENTS.values())
