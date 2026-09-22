"""Recommendation contract tests.

The decision table below is a golden file: these are human-reviewed choices.
Deliberately flipping one means changing it in the same commit and saying why.
"""
import platform

from app.services.hardware import HardwareBudget
from app.services import catalog as cat
from app.services.catalog import CATALOG, resolve, REASON_KEYS

GIB = 1024 ** 3


def budget(vram_gb, uma=False, ram_gb=0.0):
    return HardwareBudget(int(vram_gb * GIB), int(vram_gb * GIB), int(ram_gb * GIB), uma, "test")


def test_catalog_invariants():
    for entry in CATALOG:
        assert entry.quality > 0, entry.id
        assert 0 < entry.decode_fraction <= 1, entry.id
        assert entry.layers > 0 and entry.kv_bytes_per_token > 0
        assert entry.variants, entry.id
        for variant in entry.variants:
            assert variant["size_bytes"] > 0
            assert variant["backends"]


def test_recommendation_is_always_zero_spill():
    for uma, vram in [(False, 16), (False, 24), (False, 48), (True, 24), (True, 64), (True, 128)]:
        backend = "ollama" if uma else "vllm"
        out = resolve(budget(vram, uma), backend=backend)
        pick = out["pick"]
        if pick is None:
            assert out["reason_key"] == "no-recommendation"
            continue
        assert pick.zero_spill, (uma, vram, pick.entry.id)
        assert out["reason_key"] in REASON_KEYS


def test_uma_prefers_sparse_moe_over_dense():
    # The whole reason the resolver exists: on UMA the dense 14B/32B fall under
    # the comfort line, so the sparse 30B-A3B wins.
    out = resolve(budget(64, uma=True), backend="ollama")
    pick = out["pick"]
    assert pick is not None
    assert pick.entry.moe, pick.entry.id
    assert out["reason_key"] == "speed-gated-quality"


def test_speed_gate_beats_raw_quality():
    # On a huge discrete card the highest-quality dense model is still slower
    # than the comfort line, so the resolver gates it and explains why.
    out = resolve(budget(512, uma=False), backend="vllm")
    pick = out["pick"]
    assert pick is not None
    assert pick.predicted_tok_s >= 20
    gated = [c for c in out["choices"]
             if c.zero_spill and c.predicted_tok_s < 20 and c.entry.quality > pick.entry.quality]
    if gated:
        assert out["reason_key"] == "speed-gated-quality"
    else:
        assert out["reason_key"] == "best-quality-resident"


def test_spill_models_stay_visible_but_are_never_auto_recommended():
    out = resolve(budget(16, uma=False), backend="vllm")
    spilled = [c for c in out["choices"] if not c.zero_spill]
    assert spilled, "expected at least one spilling entry to remain visible"
    for choice in spilled:
        assert choice.reason_key in {"spill-visible", "physics-refused", "backend-incompatible"}


def test_no_entries_fit_returns_no_recommendation():
    tiny = HardwareBudget(2 * GIB, 2 * GIB, 0, False, "test")
    out = resolve(tiny, backend="vllm")
    assert out["pick"] is None
    assert out["reason_key"] == "no-recommendation"


def test_backend_incompatible_rows_are_explained():
    out = resolve(budget(64, uma=False), backend="ollama")
    incompatible = [c for c in out["choices"] if c.reason_key == "backend-incompatible"]
    assert incompatible
    for choice in incompatible:
        assert choice.refusal is None
        assert choice.to_dict()["fits"] is True or choice.to_dict()["fits"] is False
