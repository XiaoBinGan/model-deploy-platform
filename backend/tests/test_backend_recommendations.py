"""Apple Silicon backend recommendations.

The desktop app implements ollama, llama.cpp and mlx. It used to advertise
"transformers" as the Apple Silicon recommendation even though the desktop
cannot run it locally, which sent Mac users down a dead end.
"""
from app.services import environment


def test_apple_silicon_recommends_mlx_not_transformers(monkeypatch):
    monkeypatch.setattr(environment.platform, "system", lambda: "Darwin")
    monkeypatch.setattr(environment.platform, "machine", lambda: "arm64")
    data = environment.scan()
    assert data["apple_silicon"] is True
    assert "mlx" in data["recommended_backends"]
    # transformers is still supported by the control plane, but it is not the
    # right recommendation on a Mac: its runtime lives server-side.
    assert "transformers" not in data["recommended_backends"]


def test_apple_silicon_reports_an_mlx_check(monkeypatch):
    monkeypatch.setattr(environment.platform, "system", lambda: "Darwin")
    monkeypatch.setattr(environment.platform, "machine", lambda: "arm64")
    names = [c["name"] for c in environment.scan()["checks"]]
    assert "MLX" in names


def test_non_apple_keeps_the_gpu_server_recommendations(monkeypatch):
    monkeypatch.setattr(environment.platform, "system", lambda: "Linux")
    monkeypatch.setattr(environment.platform, "machine", lambda: "x86_64")
    data = environment.scan()
    assert data["apple_silicon"] is False
    assert "vllm" in data["recommended_backends"]
    assert "mlx" not in data["recommended_backends"]
