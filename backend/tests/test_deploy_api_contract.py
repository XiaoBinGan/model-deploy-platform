"""API contract tests for deployments, error shape and backend validation.

Each test pins a defect from docs/qa-findings-backend.md that was reproduced
before the fix, so a refactor cannot quietly bring it back:

  B-09  missing id returned 200 {} on GET but 500 on start/stop/health/test
  B-10  POST /api/deployments accepted port 0 / -1 / 70000
  B-13  a STOPPED/FAILED deployment still reported healthy=true
  B-16  an unhandled error returned text/plain instead of JSON detail
  B-17  "[::1]:8790" parsed to "["
  gap7  any backend name was accepted and reported CREATED
"""
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

from app import main
from app.services import deployments


@pytest.fixture
def client():
    return TestClient(main.app, raise_server_exceptions=False)


@pytest.fixture(autouse=True)
def _isolate_deployments():
    saved = dict(deployments.DEPLOYMENTS)
    deployments.DEPLOYMENTS.clear()
    try:
        yield
    finally:
        deployments.DEPLOYMENTS.clear()
        deployments.DEPLOYMENTS.update(saved)


@pytest.fixture
def local(monkeypatch):
    monkeypatch.setattr(main, "_client_is_local", lambda request: True)


# --- B-09: a missing deployment is 404 everywhere ---------------------------

MISSING_ACTIONS = [
    ("get", "/api/deployments/dep_missing", None),
    ("get", "/api/deployments/dep_missing/health", None),
    ("post", "/api/deployments/dep_missing/start", None),
    ("post", "/api/deployments/dep_missing/stop", None),
    ("post", "/api/deployments/dep_missing/test", {}),
    ("delete", "/api/deployments/dep_missing", None),
]


@pytest.mark.parametrize("method,path,body", MISSING_ACTIONS)
def test_missing_deployment_is_404_everywhere(client, local, method, path, body):
    fn = getattr(client, method)
    if body is None:
        response = fn(path)
    else:
        response = fn(path, json=body)
    assert response.status_code == 404, method + " " + path + " -> " + str(response.status_code)
    assert "detail" in response.json()


def test_service_get_missing_raises_instead_of_returning_empty():
    """get() used to return {} while every other lookup raised ValueError."""
    with pytest.raises(ValueError):
        deployments.get("dep_missing")


# --- B-10: port range -------------------------------------------------------

@pytest.mark.parametrize("port", [0, -1, 1023, 65536, 70000, 999999])
def test_port_out_of_range_is_rejected(client, local, port):
    response = client.post(
        "/api/deployments",
        json={"model_path": "qwen3:8b", "backend": "ollama", "port": port},
    )
    assert response.status_code == 400, f"port={port} -> {response.status_code}"


@pytest.mark.parametrize("port", [1024, 8000, 65535])
def test_port_in_range_is_accepted(client, local, port):
    response = client.post(
        "/api/deployments",
        json={"model_path": "/models/x", "backend": "transformers", "port": port},
    )
    assert response.status_code == 200
    assert response.json()["port"] == port


# --- B-13: health reflects the deployment status ----------------------------

def test_stopped_or_failed_deployment_is_never_healthy(monkeypatch):
    dep = deployments.create(model_path="m", model_id="m", backend="ollama")
    # The daemon still answers, but this deployment is not running.
    monkeypatch.setattr(deployments.httpx, "get",
                        lambda *a, **k: SimpleNamespace(status_code=200))
    for status in ("STOPPED", "FAILED", "BLOCKED", "CREATED"):
        dep["status"] = status
        result = deployments.health(dep["id"])
        assert result["healthy"] is False, status
        assert result["status"] == status


def test_running_deployment_still_probes_health(monkeypatch):
    dep = deployments.create(model_path="m", model_id="m", backend="transformers")
    dep["status"] = "RUNNING"
    monkeypatch.setattr(deployments.httpx, "get",
                        lambda *a, **k: SimpleNamespace(status_code=200))
    assert deployments.health(dep["id"])["healthy"] is True


# --- B-16: uniform JSON error shape -----------------------------------------

def test_unhandled_error_returns_json_500_without_leaking_detail(client, monkeypatch):
    def boom():
        raise RuntimeError("secret-internal-detail")

    monkeypatch.setattr(main.environment, "scan", boom)
    response = client.get("/api/environment/latest")
    assert response.status_code == 500
    assert response.headers["content-type"].startswith("application/json")
    assert response.json() == {"detail": "Internal Server Error"}
    assert "secret-internal-detail" not in response.text


def test_client_errors_keep_json_detail(client):
    assert client.post("/api/hardware/parse", json={"text": ""}).json()["detail"]
    assert client.post("/api/hardware/parse", json={}).status_code == 422


# --- B-17: IPv6 Host parsing ------------------------------------------------

class _FakeRequest:
    def __init__(self, host):
        self.headers = {"host": host}


def test_public_host_parses_ipv6_loopback():
    assert main._public_host(_FakeRequest("[::1]:8790")) == "::1"
    assert main._public_host(_FakeRequest("[::1]")) == "::1"


def test_public_host_still_strips_ports_and_reflects_only_local():
    assert main._public_host(_FakeRequest("127.0.0.1:8790")) == "127.0.0.1"
    assert main._public_host(_FakeRequest("evil.example:8790")) != "evil.example"


def test_ipv6_host_produces_a_bracketed_endpoint():
    dep = deployments.create(model_path="m", model_id="m", backend="transformers",
                             public_host="::1")
    assert dep["display_host"] == "::1"
    assert dep["endpoint"].startswith("http://[::1]:")
    assert dep["health_endpoint"].startswith("http://[::1]:")


def test_ipv6_host_header_builds_a_usable_endpoint(client, local):
    response = client.post(
        "/api/deployments",
        json={"model_path": "qwen3:8b", "backend": "ollama"},
        headers={"Host": "[::1]:8790"},
    )
    assert response.status_code == 200
    body = response.json()
    assert body["display_host"] == "::1"
    assert body["endpoint"] == "http://[::1]:11434/v1"


# --- gap 7: validate backend availability on create -------------------------

def test_unknown_backend_is_rejected(client, local):
    response = client.post(
        "/api/deployments",
        json={"model_path": "m", "backend": "definitely-not-a-backend"},
    )
    assert response.status_code == 400
    assert "detail" in response.json()


def test_known_but_unavailable_backend_is_created_blocked(client, local, monkeypatch):
    monkeypatch.setattr(deployments, "_detect_backends", lambda: [])
    response = client.post(
        "/api/deployments",
        json={"model_path": "m", "backend": "vllm"},
    )
    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "BLOCKED"
    assert any("不可用" in line for line in body["log"])


def test_available_backend_is_created_ready(client, local, monkeypatch):
    monkeypatch.setattr(deployments, "_detect_backends", lambda: ["vllm"])
    response = client.post(
        "/api/deployments",
        json={"model_path": "m", "backend": "vllm"},
    )
    assert response.status_code == 200
    assert response.json()["status"] == "CREATED"
