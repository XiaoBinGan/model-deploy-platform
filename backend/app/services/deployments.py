"""Deployment service — manages model deployments via available runtimes."""
import importlib.util
import os
import queue
import re
import shutil
import signal
import subprocess
import sys
import threading
import time
import uuid
from pathlib import Path

import httpx

DEPLOYMENTS = {}

# Backends the platform can plan or run. A name outside this set is a client
# error (400), never a silent fallback to some other runtime.
KNOWN_BACKENDS = frozenset({
    "ollama", "vllm", "sglang", "transformers", "mlx",
    "llama.cpp", "llamacpp", "docker",
})

_BACKEND_ALIASES = {"llamacpp": "llama.cpp"}

DEFAULT_DOCKER_IMAGE = "vllm/vllm-openai:latest"
DOCKER_CONTAINER_PORT_DEFAULT = 8080

# Wall-clock budget for a transformers server to answer /health before we give
# up and reap it. The old loop counted readline() calls, which is not a timeout:
# a child that stays alive but silent blocks readline() forever, and the "60
# iterations" never elapsed.
TRANSFORMERS_START_TIMEOUT = float(os.environ.get("MDP_START_TIMEOUT", "60"))

# docs/docker-design.md section 5: reject, never silently rewrite.
_IMAGE_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._/:@-]{0,199}$")
_GPUS_RE = re.compile(r"^[0-9]+(,[0-9]+)*$")
_ABS_PATH_RE = re.compile(r"^/[^:\x00]{0,400}$")
MAX_VOLUMES = 8
MAX_EXTRA_ARGS = 32
MAX_EXTRA_ARG_LENGTH = 200


class DeploymentNotFound(ValueError):
    """No deployment with the requested id (API maps this to 404)."""


class InvalidDeploymentRequest(ValueError):
    """The request cannot become a safe deployment (API maps this to 400)."""


def _detect_backends() -> list[str]:
    """Find all available runtime backends on this host.

    importlib.util is imported at module scope on purpose: importing only
    'importlib' and then touching 'importlib.util' raises AttributeError, which
    the surrounding except used to swallow, so vllm/sglang/transformers were
    never detected when this module was imported on its own.
    """
    backends = []
    # Check Ollama
    try:
        r = httpx.get("http://127.0.0.1:11434/api/tags", timeout=3)
        if r.status_code == 200:
            backends.append("ollama")
    except Exception:
        pass
    # Check vLLM / SGLang / MLX
    for module, name in (("vllm", "vllm"), ("sglang", "sglang"),
                         ("mlx", "mlx"), ("mlx_lm", "mlx")):
        try:
            if importlib.util.find_spec(module) and name not in backends:
                backends.append(name)
        except Exception:
            pass
    # Apple Silicon commonly uses Ollama or native Transformers; CUDA-only runtimes are not assumed.
    # Check transformers (always available if torch installed)
    try:
        if importlib.util.find_spec("torch") and importlib.util.find_spec("transformers"):
            backends.append("transformers")
    except Exception:
        pass
    # llama.cpp ships a llama-server / llama-cli binary rather than a Python module.
    try:
        if shutil.which("llama-server") or shutil.which("llama-cli"):
            backends.append("llama.cpp")
    except Exception:
        pass
    # Docker CLI present. The control plane only plans docker, but a missing CLI
    # still means this host cannot offer it.
    try:
        if shutil.which("docker"):
            backends.append("docker")
    except Exception:
        pass
    return backends


def available_backends() -> dict:
    return {"backends": _detect_backends()}


def _canonical_backend(name: str) -> str:
    return _BACKEND_ALIASES.get(name, name)


def container_port_for(image: str) -> int:
    """Port the image listens on, inferred from its name (docker-design section 3).

    Read-only: it is derived, never supplied by the caller.
    """
    lowered = (image or "").lower()
    if "sglang" in lowered:
        return 30000
    if "vllm" in lowered:
        return 8000
    return DOCKER_CONTAINER_PORT_DEFAULT


def _url_host(host: str) -> str:
    """Bracket a bare IPv6 literal so it can be embedded in a URL."""
    if host and ":" in host and not host.startswith("["):
        return "[" + host + "]"
    return host


def _normalize_docker_options(image, gpus, volumes, extra_args) -> dict:
    """Validate the docker-only fields (docs/docker-design.md section 5).

    Invalid values are rejected, never cleaned up: silently rewriting a user's
    image name or path is worse than a clear 400.
    """
    # No .strip() here. The docstring above is the rule: reject, never clean up.
    # " vllm/x" used to 400 in /api/plans/preview and in the desktop but return
    # 200 here, so the same string was valid through one door and invalid
    # through another. See docs/qa-round3.md R3-03.
    if not isinstance(image, str) or not image:
        image = DEFAULT_DOCKER_IMAGE
    if not _IMAGE_RE.match(image):
        raise InvalidDeploymentRequest(f"非法镜像名：{image!r}")

    if gpus is None:
        gpus = "all"
    if not isinstance(gpus, str) or not (gpus in ("all", "none") or _GPUS_RE.match(gpus)):
        raise InvalidDeploymentRequest(f"非法 gpus：{gpus!r}")

    if volumes is None:
        volumes = []
    if not isinstance(volumes, list) or len(volumes) > MAX_VOLUMES:
        raise InvalidDeploymentRequest(f"volumes 必须是不超过 {MAX_VOLUMES} 项的数组")
    normalized_volumes = []
    for volume in volumes:
        if not isinstance(volume, dict):
            raise InvalidDeploymentRequest(f"非法 volume：{volume!r}")
        host = volume.get("host")
        container = volume.get("container")
        ro = volume.get("ro", False)
        if not isinstance(host, str) or not _ABS_PATH_RE.match(host):
            raise InvalidDeploymentRequest(f"volume.host 必须是绝对路径：{host!r}")
        if not isinstance(container, str) or not _ABS_PATH_RE.match(container):
            raise InvalidDeploymentRequest(f"volume.container 必须是绝对路径：{container!r}")
        if not isinstance(ro, bool):
            raise InvalidDeploymentRequest(f"volume.ro 必须是布尔值：{ro!r}")
        normalized_volumes.append({"host": host, "container": container, "ro": ro})

    if extra_args is None:
        extra_args = []
    if not isinstance(extra_args, list) or len(extra_args) > MAX_EXTRA_ARGS:
        raise InvalidDeploymentRequest(f"extra_args 必须是不超过 {MAX_EXTRA_ARGS} 项的数组")
    normalized_args = []
    for arg in extra_args:
        if not isinstance(arg, str) or len(arg) > MAX_EXTRA_ARG_LENGTH:
            raise InvalidDeploymentRequest(f"非法 extra_args 项：{arg!r}")
        if "\x00" in arg or "\n" in arg or "\r" in arg:
            raise InvalidDeploymentRequest(f"extra_args 不能包含 NUL 或换行：{arg!r}")
        normalized_args.append(arg)

    return {"image": image, "gpus": gpus,
            "volumes": normalized_volumes, "extra_args": normalized_args}


def create(model_path: str, model_id: str, backend: str | None = None, port: int = 8000,
           dtype: str = "bfloat16", quantization: str | None = None,
           model_name: str | None = None, public_host: str | None = None,
           image=None, gpus=None, volumes=None, extra_args=None) -> dict:
    # Port range is enforced before anything else, including the Ollama port
    # rewrite, so a caller cannot smuggle 0 / -1 / 70000 past the API.
    if isinstance(port, bool) or not isinstance(port, int) or not (1024 <= port <= 65535):
        raise InvalidDeploymentRequest(f"端口必须在 1024~65535 之间：{port!r}")

    detected = _detect_backends()
    actual_backend = _canonical_backend(backend or (detected[0] if detected else "transformers"))
    if actual_backend not in KNOWN_BACKENDS:
        raise InvalidDeploymentRequest(f"未知后端：{actual_backend!r}")

    # Docker-only fields; every other backend ignores them entirely.
    docker_options = (_normalize_docker_options(image, gpus, volumes, extra_args)
                      if actual_backend == "docker" else None)

    # For ollama, use the Ollama API port directly
    if actual_backend == "ollama":
        port = 11434
        model_path = model_name or model_id

    # host is the loopback used for server-side checks; display_host is what a
    # LAN client should use. They differ when the platform is reached over the
    # network, and conflating them produces endpoints that only work locally.
    host = "127.0.0.1"
    display_host = public_host or host
    display_for_url = _url_host(display_host)

    dep_id = "dep_" + uuid.uuid4().hex[:12]
    deployment = {
        "id": dep_id,
        "model_path": model_path,
        "model_id": model_id,
        "backend": actual_backend,
        "port": port,
        "host": host,
        "display_host": display_host,
        "dtype": dtype,
        "quantization": quantization,
        "status": "CREATED",
        "pid": None,
        "endpoint": f"http://{display_for_url}:{port}/v1",
        "health_endpoint": (f"http://{display_for_url}:{port}/api/tags"
                            if actual_backend == "ollama"
                            else f"http://{display_for_url}:{port}/health"),
        "created_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "log": [],
    }

    if docker_options is not None:
        deployment.update({
            "image": docker_options["image"],
            "gpus": docker_options["gpus"],
            "volumes": docker_options["volumes"],
            "extra_args": docker_options["extra_args"],
            "container_port": container_port_for(docker_options["image"]),
        })
    else:
        deployment.update({"image": None, "gpus": None, "volumes": [],
                           "extra_args": [], "container_port": None})

    if actual_backend not in detected:
        # Known backend, but this host cannot run it. Keep the record so the
        # plan stays visible, but never claim it is usable.
        deployment["status"] = "BLOCKED"
        deployment["log"].append(
            f"后端 {actual_backend} 在本机不可用（未检测到），部署已创建但状态为 BLOCKED"
        )

    DEPLOYMENTS[dep_id] = deployment
    return deployment


def _pump(pipe, sink):
    """Feed a subprocess pipe into a queue so the main loop can poll with a
    timeout instead of blocking on readline()."""
    try:
        for line in iter(pipe.readline, b""):
            sink.put(line)
    except Exception:
        pass
    finally:
        sink.put(None)


def _drain_log(sink, dep):
    while True:
        try:
            line = sink.get_nowait()
        except queue.Empty:
            return
        if line:
            dep["log"].append(line.decode("utf-8", errors="replace").rstrip())


def _reap(proc):
    """Kill and wait for a failed child so it does not linger holding RAM/port."""
    if proc is None:
        return
    if proc.poll() is None:
        try:
            proc.kill()
        except Exception:
            pass
    try:
        proc.wait(timeout=5)
    except Exception:
        pass


def start(deployment_id: str) -> dict:
    dep = DEPLOYMENTS.get(deployment_id)
    if not dep:
        raise DeploymentNotFound(f"Deployment {deployment_id} not found")

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
        lines = queue.Queue()
        threading.Thread(target=_pump, args=(proc.stdout, lines), daemon=True).start()
        deadline = time.monotonic() + TRANSFORMERS_START_TIMEOUT
        healthy = False
        while time.monotonic() < deadline:
            _drain_log(lines, dep)
            if proc.poll() is not None:
                break
            try:
                r = httpx.get(f"http://{dep['host']}:{dep['port']}/health", timeout=1)
                if r.status_code == 200:
                    healthy = True
                    break
            except Exception:
                pass
            time.sleep(0.5)
        _drain_log(lines, dep)
        if healthy:
            dep["status"] = "RUNNING"
        else:
            dep["status"] = "FAILED"
            dep["log"].append(
                f"transformers 服务在 {TRANSFORMERS_START_TIMEOUT:g}s 内未通过 /health，已终止进程"
            )
            _reap(proc)

    elif dep["backend"] == "docker":
        # The control plane never runs docker: the container is started by the
        # desktop app, which owns the local argv. See docs/docker-design.md section 1.
        dep["status"] = "BLOCKED"
        dep["log"].append("容器由桌面端启动，控制面只做规划")

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
        raise DeploymentNotFound(f"Deployment {deployment_id} not found")
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


def delete(deployment_id: str) -> dict:
    """Stop the deployment if it is live, then drop the record.

    Before this the list only ever grew: create/start/stop existed but nothing
    could remove a deployment, so junk entries accumulated with no way out.
    """
    dep = DEPLOYMENTS.get(deployment_id)
    if not dep:
        raise DeploymentNotFound(f"Deployment {deployment_id} not found")
    if dep.get("pid") or dep.get("status") in ("RUNNING", "STARTING"):
        try:
            stop(deployment_id)
        except Exception:
            pass
    return DEPLOYMENTS.pop(deployment_id)


def get(deployment_id: str) -> dict:
    dep = DEPLOYMENTS.get(deployment_id)
    if not dep:
        raise DeploymentNotFound(f"Deployment {deployment_id} not found")
    return dep


def list_all() -> list[dict]:
    return list(DEPLOYMENTS.values())


def health(deployment_id: str) -> dict:
    """Real health check against the running service, not a status flag."""
    dep = DEPLOYMENTS.get(deployment_id)
    if not dep:
        raise DeploymentNotFound(f"Deployment {deployment_id} not found")
    url = dep["health_endpoint"]
    status = dep["status"]
    if status != "RUNNING":
        # A STOPPED/FAILED/BLOCKED deployment is not healthy even if some
        # unrelated daemon still answers on the port (Ollama's /api/tags says
        # the daemon is up, not that this model is loaded).
        return {"deployment_id": deployment_id, "url": url, "healthy": False,
                "status": status, "reason": f"部署状态为 {status}，服务未在运行"}
    try:
        r = httpx.get(url, timeout=5)
        return {"deployment_id": deployment_id, "url": url, "status_code": r.status_code,
                "healthy": r.status_code == 200, "status": status}
    except Exception as e:
        return {"deployment_id": deployment_id, "url": url, "healthy": False,
                "error": str(e), "status": status}


def test_chat(deployment_id: str, message: str = "你好，请用一句话介绍你自己",
              model_name: str | None = None, max_tokens: int = 512) -> dict:
    """Send a real OpenAI-compatible chat completion to the deployed service."""
    dep = DEPLOYMENTS.get(deployment_id)
    if not dep:
        raise DeploymentNotFound(f"Deployment {deployment_id} not found")
    model = model_name or dep["model_path"]
    url = f"http://{dep['host']}:{dep['port']}/v1/chat/completions"
    try:
        r = httpx.post(url, json={
            "model": model,
            "messages": [{"role": "user", "content": message}],
            "max_tokens": max_tokens,
        }, timeout=120)
        if r.status_code != 200:
            return {"ok": False, "url": url, "status_code": r.status_code, "error": r.text[:500]}
        data = r.json()
        choice = (data.get("choices") or [{}])[0]
        reply_message = choice.get("message") or {}
        reply = reply_message.get("content") or ""
        source = "content"
        # Thinking models keep the visible answer in content and the chain of
        # thought in reasoning. When the budget runs out mid-thought, content is
        # empty and reasoning is the only text available; a blank reply would
        # look like a broken deployment.
        if not reply.strip():
            thought = reply_message.get("reasoning") or reply_message.get("reasoning_content")
            if isinstance(thought, str) and thought.strip():
                reply = thought
                source = "reasoning"
        result = {
            "ok": True, "url": url, "status_code": r.status_code, "model": model,
            "reply": reply, "reply_source": source,
            "finish_reason": choice.get("finish_reason"),
            "usage": data.get("usage", {}),
        }
        if choice.get("finish_reason") == "length" and source == "reasoning":
            result["hint"] = "回复被 max tokens 截断：模型把预算用在了思考上。请把最大 Token 调到 512 以上。"
        return result
    except Exception as e:
        return {"ok": False, "url": url, "error": str(e)}
