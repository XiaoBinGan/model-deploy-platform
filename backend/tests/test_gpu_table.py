"""GPU name lookup.

The table is the only way a browser-only probe can guess VRAM, so a wrong match
is worse than no match: it silently produces a confident, incorrect budget.
"""
from app.services.gpu_table import lookup


def test_apple_m5_is_in_the_table():
    """This project targets Apple Silicon; the newest chip must not miss."""
    for name in ("Apple M5", "Apple M5 Pro", "Apple M5 Max"):
        r = lookup(name)
        assert r["matched"] is True, name
        assert r["vendor"] == "apple", name
        assert r["uma"] is True, name
        assert r["vram_gb"] is None, "Apple Silicon has no separate VRAM"


def test_bare_apple_gpu_matches():
    """normalize() strips "gpu", so this arrives as bare "apple"."""
    r = lookup("Apple GPU")
    assert r["matched"] is True
    assert r["vendor"] == "apple"
    assert r["uma"] is True


def test_a_longer_number_does_not_match_a_shorter_key():
    """"rtx 40900" is not an RTX 4090, and must not borrow its 24GB."""
    assert lookup("RTX 40900")["matched"] is False
    assert lookup("RTX 50900")["matched"] is False
    # The real card still resolves.
    assert lookup("NVIDIA GeForce RTX 4090")["vram_gb"] == 24


def test_a_letter_key_still_prefixes_a_longer_name():
    """The digit guard must not break legitimate prefixes like MX150."""
    r = lookup("GeForce MX150")
    assert r["matched"] is True
    assert r["vram_gb"] == 2


def test_specific_variants_win_over_their_prefixes():
    """Table order is most-specific-first; "5070 ti" must not fall to "5070"."""
    assert lookup("NVIDIA GeForce RTX 5070 Ti")["vram_gb"] == 16
    assert lookup("NVIDIA GeForce RTX 5070")["vram_gb"] == 12
    assert lookup("Radeon RX 7900 XTX")["vram_gb"] == 24


def test_unknown_name_is_a_miss_not_a_guess():
    r = lookup("Some Future Adapter 9999")
    assert r["matched"] is False
    assert r["vram_gb"] is None
