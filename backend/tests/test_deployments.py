"""Deployment lifecycle contract tests."""
import pytest

from app.services import deployments


def test_missing_deployment_raises():
    with pytest.raises(ValueError):
        deployments.health("dep_missing")
    with pytest.raises(ValueError):
        deployments.test_chat("dep_missing")


def test_ollama_deployment_uses_ollama_port_and_model_tag():
    dep = deployments.create(model_path="ignored", model_id="qwen2.5-7b", backend="ollama",
                             port=9999, model_name="qwen2.5:7b")
    assert dep["port"] == 11434
    assert dep["model_path"] == "qwen2.5:7b"
    assert dep["endpoint"] == "http://127.0.0.1:11434/v1"
    assert dep["health_endpoint"].endswith("/api/tags")
    assert dep["status"] == "CREATED"


def test_transformers_deployment_keeps_requested_port():
    dep = deployments.create(model_path="/models/Qwen3-8B", model_id="qwen3-8b",
                             backend="transformers", port=8100)
    assert dep["port"] == 8100
    assert dep["health_endpoint"].endswith("/health")


def test_deployments_are_listed():
    dep = deployments.create(model_path="/models/x", model_id="x", backend="transformers")
    assert any(d["id"] == dep["id"] for d in deployments.list_all())
