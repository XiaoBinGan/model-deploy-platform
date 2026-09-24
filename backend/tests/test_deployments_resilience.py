"""Regressions for deployment-service internals.

  B-14  the profile code is an unkeyed checksum, not a signature
  B-18  _detect_backends touched importlib.util without importing it
  B-22  transformers start blocked on readline() forever and leaked the child
  B-24  catalog/*.yaml were dead config that looked editable
"""
import subprocess
import sys
from pathlib import Path

import pytest

from app.services import deployments, profiles

BACKEND_DIR = Path(__file__).resolve().parents[1]
REPO_DIR = BACKEND_DIR.parent


@pytest.fixture(autouse=True)
def _isolate_deployments():
    saved = dict(deployments.DEPLOYMENTS)
    deployments.DEPLOYMENTS.clear()
    try:
        yield
    finally:
        deployments.DEPLOYMENTS.clear()
        deployments.DEPLOYMENTS.update(saved)


# --- B-14: the code is documented as a checksum, not a signature ------------

def test_profile_code_is_documented_as_a_checksum_not_a_signature():
    doc = (profiles.__doc__ or "").lower()
    assert "not a signature" in doc
    assert "tamper" in doc


# --- B-18: importlib.util is imported at module scope -----------------------

def test_deployments_module_imports_importlib_util():
    """Touching importlib.util after only 'import importlib' raises
    AttributeError, which the detector's except swallowed: backends went
    undetected whenever this module was imported without fastapi first."""
    assert hasattr(deployments, "importlib")
    assert hasattr(deployments.importlib, "util")


def test_detection_works_in_a_fresh_interpreter():
    """Same check in isolation, where no other import has loaded importlib.util."""
    code = (
        "import importlib;"
        "from app.services import deployments;"
        "print(hasattr(importlib, 'util'))"
    )
    out = subprocess.run([sys.executable, "-c", code], cwd=str(BACKEND_DIR),
                         capture_output=True, text=True, timeout=60)
    assert out.returncode == 0, out.stderr
    assert out.stdout.strip() == "True"


# --- B-22: transformers start has a timeout and reaps the child -------------

class _EofStdout:
    def readline(self):
        return b""


class _FakeProc:
    def __init__(self):
        self.pid = 4242
        self.stdout = _EofStdout()
        self.killed = False
        self.returncode = None

    def poll(self):
        return self.returncode

    def kill(self):
        self.killed = True
        self.returncode = -9

    def wait(self, timeout=None):
        return self.returncode


def test_transformers_start_times_out_and_kills_the_child(monkeypatch):
    """The old loop counted 60 readline() calls, which is not a timeout, and the
    failure branch never killed the child."""
    dep = deployments.create(model_path="/models/x", model_id="x",
                             backend="transformers", port=8123)
    proc = _FakeProc()
    monkeypatch.setattr(deployments.subprocess, "Popen", lambda *a, **k: proc)
    monkeypatch.setattr(deployments.httpx, "get",
                        lambda *a, **k: (_ for _ in ()).throw(RuntimeError("no health")))
    monkeypatch.setattr(deployments, "TRANSFORMERS_START_TIMEOUT", 0.05)
    monkeypatch.setattr(deployments.time, "sleep", lambda seconds: None)

    result = deployments.start(dep["id"])

    assert result["status"] == "FAILED"
    assert proc.killed is True, "a failed start must not leave an orphan process"


# --- B-24: dead catalog config is gone --------------------------------------

def test_dead_catalog_yaml_config_is_removed():
    """No code ever loaded these files, so editing them silently did nothing."""
    assert not (REPO_DIR / "catalog" / "models.yaml").exists()
    assert not (REPO_DIR / "catalog" / "compatibility.yaml").exists()
