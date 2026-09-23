"""MLX catalog wiring.

Every model in the catalog needs an MLX counterpart, and the mlx-community repo
id is derived by convention rather than stored, so the convention has to be
checked against the Hub or it rots silently.
"""
import pytest

from app.services.catalog import CATALOG, mlx_repo, select_variant
from app.services.hardware import HardwareBudget


def _apple_budget(ram_gb=24.0):
    """A 24GB Apple Silicon machine: unified memory, no separate VRAM."""
    total = int(ram_gb * 1024 ** 3)
    return HardwareBudget(
        usable_vram_bytes=int(ram_gb * 0.8 * 1024 ** 3),
        total_device_bytes=total,
        ram_available_bytes=int(ram_gb * 0.7 * 1024 ** 3),
        uma=True,
        source="test",
        device_name="Apple M5",
    )


def test_mlx_repo_follows_the_mlx_community_convention():
    assert mlx_repo("Qwen/Qwen3-8B") == "mlx-community/Qwen3-8B-4bit"
    assert mlx_repo("google/gemma-3-4b-it") == "mlx-community/gemma-3-4b-it-4bit"
    assert mlx_repo("") is None
    assert mlx_repo("no-slash") is None


def test_every_model_has_an_mlx_variant_except_the_cuda_only_extras():
    without = [e.id for e in CATALOG
               if not any("mlx" in v["backends"] for v in e.variants)]
    # These two are AWQ/GPTQ artifacts with no MLX counterpart on purpose.
    assert without == ["qwen2.5-vl-7b-cuda", "phi-4-mini-cuda"]


def test_mlx_variants_carry_a_repo_and_the_mlx_backend():
    for entry in CATALOG:
        for variant in entry.variants:
            if "mlx" not in variant["backends"]:
                continue
            assert variant["repo"].startswith("mlx-community/"), entry.id
            assert variant["backends"] == ["mlx"], entry.id


def test_selecting_the_mlx_backend_yields_an_mlx_variant():
    budget = _apple_budget()
    entry = next(e for e in CATALOG if e.id == "qwen3-8b")
    choice = select_variant(entry, budget, backend="mlx")
    assert choice.variant["quant"] == "mlx-4bit"
    assert choice.reason_key != "backend-incompatible"
    assert choice.to_dict()["mlx_repo"] == "mlx-community/Qwen3-8B-4bit"


def test_mlx_backend_does_not_offer_gguf_variants():
    """The GGUF variant must not leak into an MLX plan."""
    budget = _apple_budget()
    entry = next(e for e in CATALOG if e.id == "qwen3-8b")
    choice = select_variant(entry, budget, backend="mlx")
    assert "ollama" not in choice.variant["backends"]
    assert choice.variant["quant"] not in ("q8_0", "q4_k_m")


@pytest.mark.network
def test_derived_mlx_repos_exist_on_the_hub():
    """Verify the convention against the real Hub.

    Deselected by default; run with: pytest -m network
    """
    import urllib.request

    seen = []
    for entry in CATALOG:
        for variant in entry.variants:
            repo = variant.get("repo")
            if repo and repo not in seen:
                seen.append(repo)
    assert seen, "no mlx repos in the catalog"

    missing = []
    for repo in seen:
        url = "https://huggingface.co/api/models/" + repo
        try:
            with urllib.request.urlopen(url, timeout=20):  # noqa: S310
                pass
        except Exception as exc:
            missing.append(repo + " (" + type(exc).__name__ + ")")
    assert not missing, "derived mlx repos that do not exist: " + ", ".join(missing)
