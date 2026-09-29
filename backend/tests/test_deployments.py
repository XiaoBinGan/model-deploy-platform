"""Deployment lifecycle contract tests."""
import pytest

from app.services import deployments


def test_missing_deployment_raises():
    with pytest.raises(ValueError):
        deployments.health("dep_missing")
    with pytest.raises(ValueError):
        deployments.test_chat("dep_missing")


def test_ollama_deployment_uses_ollama_port_and_model_tag(monkeypatch):
    # create() 的状态取决于本机探测到的后端：没装 ollama 的机器上同一份代码
    # 会被正确地标成 BLOCKED（deployments.py:247）。这条用例断言的是「端口与
    # 模型标签按 ollama 的规矩改写」，所以先把探测结果固定成 ollama 可用，
    # 否则它在 CI / 开发机上通过与否取决于那台机器装没装 ollama。
    monkeypatch.setattr(deployments, "_detect_backends", lambda: ["ollama"])
    dep = deployments.create(model_path="ignored", model_id="qwen2.5-7b", backend="ollama",
                             port=9999, model_name="qwen2.5:7b")
    assert dep["port"] == 11434
    assert dep["model_path"] == "qwen2.5:7b"
    assert dep["endpoint"] == "http://127.0.0.1:11434/v1"
    assert dep["health_endpoint"].endswith("/api/tags")
    assert dep["status"] == "CREATED"


def test_ollama_deployment_is_blocked_when_the_backend_is_absent(monkeypatch):
    """探测不到 ollama 时必须如实标 BLOCKED，而不是谎报 CREATED。"""
    monkeypatch.setattr(deployments, "_detect_backends", lambda: [])
    dep = deployments.create(model_path="ignored", model_id="qwen2.5-7b", backend="ollama",
                             port=9999, model_name="qwen2.5:7b")
    assert dep["status"] == "BLOCKED"
    # 记录仍然保留，端口与标签照旧，方便用户看到「本来会跑成什么样」。
    assert dep["port"] == 11434
    assert dep["model_path"] == "qwen2.5:7b"


def test_transformers_deployment_keeps_requested_port():
    dep = deployments.create(model_path="/models/Qwen3-8B", model_id="qwen3-8b",
                             backend="transformers", port=8100)
    assert dep["port"] == 8100
    assert dep["health_endpoint"].endswith("/health")


def test_deployments_are_listed():
    dep = deployments.create(model_path="/models/x", model_id="x", backend="transformers")
    assert any(d["id"] == dep["id"] for d in deployments.list_all())
