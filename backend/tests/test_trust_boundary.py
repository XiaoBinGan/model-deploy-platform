"""Trust boundary of the control plane.

The control plane is unauthenticated, so what it will do for an unauthenticated
caller is the whole security story. These pin down the three ways that used to
be too permissive: cross-origin access, which endpoints check the caller at all,
and whether the caller controls the URLs handed back to the UI.
"""
import subprocess
import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app import main

BACKEND_DIR = Path(__file__).resolve().parents[1]

MUTATING = [
    ("post", "/api/deployments"),
    ("post", "/api/deployments/dep_x/start"),
    ("post", "/api/deployments/dep_x/stop"),
    ("delete", "/api/deployments/dep_x"),
    ("post", "/api/deployments/dep_x/test"),
]


# A valid create body, reused everywhere: FastAPI validates the request model
# before the endpoint runs, so an empty body would fail with 422 and never reach
# the guard this file is about. The other endpoints ignore the extra fields.
BODY = {"model_path": "qwen3:8b", "backend": "ollama"}


@pytest.fixture
def client():
    # raise_server_exceptions=False: start/stop on an unknown id raise ValueError
    # from the handler, and these assertions are about the guard, not the handler.
    return TestClient(main.app, raise_server_exceptions=False)


def call(client, method, path):
    """DELETE takes no body, and httpx refuses json= on it."""
    fn = getattr(client, method)
    return fn(path) if method == "delete" else fn(path, json=BODY)


# --- cross-origin access ----------------------------------------------------

def test_cors_middleware_is_absent_by_default():
    """The page is same-origin, so nothing needs cross-origin access.

    A wildcard was actively harmful: this plane is unauthenticated, so any site
    a user visited could drive it from their browser.
    """
    assert main.CORS_ORIGINS == []
    installed = [m.cls.__name__ for m in main.app.user_middleware]
    assert "CORSMiddleware" not in installed


def test_cross_origin_preflight_is_not_approved(client):
    r = client.options(
        "/api/deployments",
        headers={
            "Origin": "https://evil.example",
            "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": "content-type",
        },
    )
    assert "access-control-allow-origin" not in {k.lower() for k in r.headers}


def test_same_origin_requests_are_unaffected(client, monkeypatch):
    monkeypatch.setattr(main, "_client_is_local", lambda request: True)
    r = client.get("/api/health")
    assert r.status_code == 200


def test_cors_origins_env_reenables_the_middleware():
    """A split deployment can opt back in; verified in a fresh interpreter so the
    module is not reloaded underneath the other tests."""
    code = (
        "import os; os.environ['MDP_CORS_ORIGINS'] = 'https://ok.example';"
        "from app import main;"
        "print(main.CORS_ORIGINS);"
        "print([m.cls.__name__ for m in main.app.user_middleware])"
    )
    out = subprocess.run(
        [sys.executable, "-c", code],
        cwd=str(BACKEND_DIR), capture_output=True, text=True, timeout=60,
    )
    assert out.returncode == 0, out.stderr
    assert "https://ok.example" in out.stdout
    assert "CORSMiddleware" in out.stdout


# --- which endpoints check the caller ---------------------------------------

@pytest.mark.parametrize("method,path", MUTATING)
def test_remote_clients_are_refused_on_every_mutating_endpoint(client, monkeypatch, method, path):
    """Guarding only POST /api/deployments left start/stop/delete/test open,
    which is the same control over the host by another route."""
    monkeypatch.setattr(main, "_client_is_local", lambda request: False)
    monkeypatch.setattr(main, "ALLOW_REMOTE_DEPLOY", False)
    r = call(client, method, path)
    assert r.status_code == 403, method + " " + path + " -> " + str(r.status_code)


@pytest.mark.parametrize("method,path", MUTATING)
def test_allow_remote_deploy_still_opens_them(client, monkeypatch, method, path):
    """The opt-in must keep working; a 404 here means it got past the guard."""
    monkeypatch.setattr(main, "_client_is_local", lambda request: False)
    monkeypatch.setattr(main, "ALLOW_REMOTE_DEPLOY", True)
    r = call(client, method, path)
    assert r.status_code != 403, method + " " + path


def test_reads_stay_open_for_remote_clients(client, monkeypatch):
    """A shared service still hands out recommendations to the network."""
    monkeypatch.setattr(main, "_client_is_local", lambda request: False)
    monkeypatch.setattr(main, "ALLOW_REMOTE_DEPLOY", False)
    assert client.get("/api/health").status_code == 200
    assert client.get("/api/deployments").status_code == 200
    assert client.get("/api/models/catalog").status_code == 200


def test_local_clients_are_allowed(client, monkeypatch):
    monkeypatch.setattr(main, "_client_is_local", lambda request: True)
    r = client.post("/api/deployments", json={"model_path": "qwen3:8b", "backend": "ollama"})
    assert r.status_code == 200


# --- the caller does not get to choose the URLs -----------------------------

def test_foreign_host_header_is_not_reflected(client, monkeypatch):
    """The Host header is reflected into the endpoint URLs the UI shows and
    calls, so a caller-controlled one would aim those at a host of their
    choosing."""
    monkeypatch.setattr(main, "_client_is_local", lambda request: True)
    r = client.post(
        "/api/deployments",
        json={"model_path": "qwen3:8b", "backend": "ollama"},
        headers={"Host": "evil.example"},
    )
    assert r.status_code == 200
    body = r.json()
    assert "evil.example" not in body["display_host"]
    assert "evil.example" not in body["endpoint"]
    assert "evil.example" not in body["health_endpoint"]


def test_loopback_host_header_is_kept(client, monkeypatch):
    monkeypatch.setattr(main, "_client_is_local", lambda request: True)
    r = client.post(
        "/api/deployments",
        json={"model_path": "qwen3:8b", "backend": "ollama"},
        headers={"Host": "127.0.0.1:8790"},
    )
    assert r.json()["display_host"] == "127.0.0.1"


def test_public_host_helper_falls_back_instead_of_reflecting():
    class FakeRequest:
        headers = {"host": "attacker.test:1234"}
        url = None

    resolved = main._public_host(FakeRequest())
    assert resolved != "attacker.test"
    assert resolved in main._local_addresses() or resolved == "127.0.0.1"
