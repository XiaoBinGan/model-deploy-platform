"""environment.scan robustness (B-23) and the docker recommendation.

The malformed-row test fails on the pre-fix code: int(float(...)) raised and the
whole GPU block (plus the endpoint) 500'd.
"""
from app.services import environment


def test_scan_skips_malformed_nvidia_smi_rows(monkeypatch):
    def fake_run(args):
        if args and args[0] == "nvidia-smi":
            return (
                "NVIDIA GeForce RTX 4090, 24564, 23000, 555.1\n"
                "Broken Card, not-a-number, 100, 555.1\n"
                "Truncated Card, 8192\n"
                "CUDA warning: something changed, please reboot\n"
            )
        return ""

    monkeypatch.setattr(environment, "run", fake_run)
    monkeypatch.setattr(environment.platform, "system", lambda: "Linux")
    monkeypatch.setattr(environment.platform, "machine", lambda: "x86_64")
    data = environment.scan()
    assert [gpu["name"] for gpu in data["gpu"]] == ["NVIDIA GeForce RTX 4090"]
    assert data["gpu"][0]["memory_total_mb"] == 24564
    assert data["gpu"][0]["memory_free_mb"] == 23000


def test_scan_recommends_docker_when_the_cli_is_present(monkeypatch):
    monkeypatch.setattr(environment.platform, "system", lambda: "Linux")
    monkeypatch.setattr(environment.platform, "machine", lambda: "x86_64")
    monkeypatch.setattr(environment, "run", lambda args: "")
    monkeypatch.setattr(environment.shutil, "which",
                        lambda name: "/usr/bin/docker" if name == "docker" else None)
    data = environment.scan()
    assert "docker" in data["recommended_backends"]
    check = next(c for c in data["checks"] if c["name"] == "Docker")
    # PATH presence is all we know; the message must not claim the daemon is up.
    assert "守护进程" in check["message"]


def test_scan_does_not_claim_daemon_status(monkeypatch):
    monkeypatch.setattr(environment.platform, "system", lambda: "Linux")
    monkeypatch.setattr(environment.platform, "machine", lambda: "x86_64")
    monkeypatch.setattr(environment, "run", lambda args: "")
    monkeypatch.setattr(environment.shutil, "which", lambda name: None)
    data = environment.scan()
    assert "docker" not in data["recommended_backends"]
    assert data["docker"]["daemon"] == "unknown"
    check = next(c for c in data["checks"] if c["name"] == "Docker")
    assert check["status"] == "UNKNOWN"
