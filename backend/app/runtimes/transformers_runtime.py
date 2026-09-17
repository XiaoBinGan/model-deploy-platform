"""Transformers runtime backend — provides real inference for MVP when vLLM/SGLang are not installed."""
import subprocess, sys, time, json, os
from pathlib import Path

def _python():
    return sys.executable

def detect(environment: dict) -> dict:
    try:
        import torch, transformers
        return {
            "installed": True,
            "backend": "transformers",
            "torch_version": torch.__version__,
            "transformers_version": transformers.__version__,
            "cuda_available": torch.cuda.is_available(),
            "gpu_name": torch.cuda.get_device_name(0) if torch.cuda.is_available() else None,
        }
    except Exception as e:
        return {"installed": False, "error": str(e)}

def build_command(model_path: str, port: int, dtype: str = "bfloat16") -> list[str]:
    return [
        _python(), "-m", "app.runtimes.transformers_server",
        "--model-path", model_path,
        "--port", str(port),
        "--dtype", dtype,
    ]

def start(command: list[str], env: dict | None = None) -> subprocess.Popen:
    return subprocess.Popen(
        command,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        env=env or os.environ,
    )

def health_check(host: str, port: int, timeout: int = 30) -> dict:
    import httpx
    for _ in range(timeout * 2):
        try:
            r = httpx.get(f"http://{host}:{port}/health", timeout=2)
            if r.status_code == 200:
                return {"healthy": True, "status_code": 200}
        except Exception:
            time.sleep(0.5)
    return {"healthy": False}
