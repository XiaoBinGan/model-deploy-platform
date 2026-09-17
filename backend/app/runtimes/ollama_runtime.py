"""Ollama runtime backend — uses Ollama's OpenAI-compatible API.
Ollama runs as a separate service; this backend detects it and manages model loading."""
import time, json
import httpx

OLLAMA_BASE = "http://127.0.0.1:11434"

def detect(environment: dict | None = None) -> dict:
    try:
        r = httpx.get(f"{OLLAMA_BASE}/api/tags", timeout=5)
        if r.status_code == 200:
            models = r.json().get("models", [])
            return {
                "installed": True,
                "backend": "ollama",
                "api_base": OLLAMA_BASE,
                "model_count": len(models),
                "openai_compatible": True,
                "openai_endpoint": f"{OLLAMA_BASE}/v1",
            }
    except Exception as e:
        return {"installed": False, "error": str(e)}
    return {"installed": False}

def list_models() -> list[dict]:
    try:
        r = httpx.get(f"{OLLAMA_BASE}/api/tags", timeout=10)
        if r.status_code == 200:
            return [
                {
                    "id": m["name"],
                    "name": m["name"],
                    "size_gb": round(m.get("size", 0) / 1024**3, 1),
                    "quantization": m.get("details", {}).get("quantization_level", "unknown"),
                    "backend": "ollama",
                    "runtimes": ["ollama"],
                }
                for m in r.json().get("models", [])
            ]
    except Exception:
        pass
    return []

def health_check(host: str = "127.0.0.1", port: int = 11434) -> dict:
    try:
        r = httpx.get(f"http://{host}:{port}/api/tags", timeout=5)
        return {"healthy": r.status_code == 200, "status_code": r.status_code}
    except Exception as e:
        return {"healthy": False, "error": str(e)}

def build_command(model_name: str, port: int = 11434) -> list[str]:
    # Ollama doesn't need a separate start command if already running,
    # but we can use `ollama run` to preload the model
    return ["ollama", "run", model_name, "--keepalive", "30m"]

def start_model(model_name: str) -> dict:
    """Preload a model into Ollama's memory."""
    try:
        r = httpx.post(
            f"{OLLAMA_BASE}/api/generate",
            json={"model": model_name, "prompt": "", "stream": False, "keep_alive": "30m"},
            timeout=120,
        )
        return {"loaded": True, "model": model_name}
    except Exception as e:
        return {"loaded": False, "error": str(e)}
