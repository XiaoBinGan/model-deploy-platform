"""Docker control-plane contract (docs/docker-design.md sections 1, 2, 3, 5).

The control plane only plans docker deployments; the desktop app builds the
argv and starts the container. These tests pin the request fields, the defaults,
the read-only container_port inference, the hard validation rules and the
"start is BLOCKED" rule.
"""
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
    # Deterministic availability: pretend docker is installed.
    monkeypatch.setattr(deployments, "_detect_backends", lambda: ["docker"])


def _create(client, **overrides):
    body = {"model_path": "Qwen/Qwen3-8B", "backend": "docker"}
    body.update(overrides)
    return client.post("/api/deployments", json=body)


def test_docker_request_fields_are_stored(client, local):
    response = _create(
        client,
        image="lmsysorg/sglang:latest",
        gpus="0,1",
        volumes=[{"host": "/Users/me/models", "container": "/models", "ro": True}],
        extra_args=["--max-model-len", "65536"],
    )
    assert response.status_code == 200
    body = response.json()
    assert body["image"] == "lmsysorg/sglang:latest"
    assert body["gpus"] == "0,1"
    assert body["volumes"] == [{"host": "/Users/me/models", "container": "/models", "ro": True}]
    assert body["extra_args"] == ["--max-model-len", "65536"]
    assert body["container_port"] == 30000


def test_docker_defaults(client, local):
    body = _create(client).json()
    assert body["image"] == "vllm/vllm-openai:latest"
    assert body["gpus"] == "all"
    assert body["volumes"] == []
    assert body["extra_args"] == []
    assert body["container_port"] == 8000


def test_empty_image_falls_back_to_default(client, local):
    body = _create(client, image="").json()
    assert body["image"] == "vllm/vllm-openai:latest"
    assert body["container_port"] == 8000


@pytest.mark.parametrize("image,expected", [
    ("lmsysorg/sglang:latest", 30000),
    ("vllm/vllm-openai:latest", 8000),
    ("ghcr.io/ggerganov/llama.cpp:server", 8080),
])
def test_container_port_is_inferred_from_the_image(image, expected):
    assert deployments.container_port_for(image) == expected


def test_non_docker_backends_ignore_container_fields(client, local):
    response = client.post("/api/deployments", json={
        "model_path": "qwen3:8b",
        "backend": "ollama",
        "image": "not valid; rm -rf /",
        "gpus": "nonsense",
        "volumes": [{"host": "relative", "container": "relative"}],
        "extra_args": ["a" + chr(10) + "b"],
    })
    assert response.status_code == 200
    body = response.json()
    assert body["image"] is None
    assert body["gpus"] is None
    assert body["volumes"] == []
    assert body["extra_args"] == []
    assert body["container_port"] is None


BACKTICK = chr(96)
NEWLINE = chr(10)
NUL = chr(0)

INVALID_DOCKER_PAYLOADS = [
    {"image": "vllm/vllm-openai:latest; rm -rf /"},
    {"image": "bad image"},
    {"image": "$(whoami)"},
    {"image": "vllm" + BACKTICK + "x" + BACKTICK},
    {"image": "vllm/vllm-openai:latest&"},
    {"gpus": "0;1"},
    {"gpus": "all,0"},
    {"gpus": "-1"},
    {"gpus": "0 1"},
    {"volumes": [{"host": "relative/path", "container": "/models"}]},
    {"volumes": [{"host": "/models", "container": "models"}]},
    {"volumes": [{"host": "/a:b", "container": "/models"}]},
    {"volumes": [{"host": "/models", "container": "/c", "ro": "yes"}]},
    {"volumes": [{"host": f"/m{i}", "container": f"/c{i}"} for i in range(9)]},
    {"extra_args": ["x"] * 33},
    {"extra_args": ["x" * 201]},
    {"extra_args": ["a" + NEWLINE + "b"]},
    {"extra_args": ["a" + NUL + "b"]},
]


@pytest.mark.parametrize("payload", INVALID_DOCKER_PAYLOADS)
def test_invalid_docker_fields_are_rejected(client, local, payload):
    response = _create(client, **payload)
    assert response.status_code == 400, f"{payload} -> {response.status_code}"
    assert "detail" in response.json()


def test_docker_start_is_blocked_with_the_desktop_reason():
    dep = deployments.create(model_path="m", model_id="m", backend="docker")
    result = deployments.start(dep["id"])
    assert result["status"] == "BLOCKED"
    assert any("桌面端" in line for line in result["log"])
