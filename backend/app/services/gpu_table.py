"""GPU name -> VRAM lookup.

Browsers cannot read VRAM, so the only signal is the adapter name. This table
is the single source of truth for turning that name into a capacity, and it is
explicitly a lookup, not a measurement: every result is marked untrusted and
the UI asks the user to confirm.

Apple Silicon is special: there is no separate VRAM, the GPU shares the
machine's unified memory, so vram_gb stays None and uma is True.
"""

# Ordered most-specific first. Matching is plain substring on a normalized name,
# so keep longer keys before their prefixes (e.g. "rtx 4070 ti" before "rtx 4070").
GPU_TABLE = [
    ("apple m4 max", "apple", None, True),
    ("apple m4 pro", "apple", None, True),
    ("apple m4", "apple", None, True),
    ("apple m3 max", "apple", None, True),
    ("apple m3 pro", "apple", None, True),
    ("apple m3 ultra", "apple", None, True),
    ("apple m3", "apple", None, True),
    ("apple m2 ultra", "apple", None, True),
    ("apple m2 max", "apple", None, True),
    ("apple m2 pro", "apple", None, True),
    ("apple m2", "apple", None, True),
    ("apple m1 ultra", "apple", None, True),
    ("apple m1 max", "apple", None, True),
    ("apple m1 pro", "apple", None, True),
    ("apple m1", "apple", None, True),
    ("apple gpu", "apple", None, True),
    ("nvidia h100", "nvidia", 80, False),
    ("nvidia a100", "nvidia", 80, False),
    ("nvidia l40s", "nvidia", 48, False),
    ("nvidia a10g", "nvidia", 24, False),
    ("nvidia a10", "nvidia", 24, False),
    ("nvidia t4", "nvidia", 16, False),
    ("rtx 5090", "nvidia", 32, False),
    ("rtx 5080", "nvidia", 16, False),
    ("rtx 5070 ti", "nvidia", 16, False),
    ("rtx 5070", "nvidia", 12, False),
    ("rtx 5060 ti", "nvidia", 16, False),
    ("rtx 5060", "nvidia", 8, False),
    ("rtx 4090", "nvidia", 24, False),
    ("rtx 4080", "nvidia", 16, False),
    ("rtx 4070 ti", "nvidia", 16, False),
    ("rtx 4070", "nvidia", 12, False),
    ("rtx 4060 ti", "nvidia", 16, False),
    ("rtx 4060", "nvidia", 8, False),
    ("rtx 3090", "nvidia", 24, False),
    ("rtx 3080 ti", "nvidia", 12, False),
    ("rtx 3080", "nvidia", 10, False),
    ("rtx 3070 ti", "nvidia", 8, False),
    ("rtx 3070", "nvidia", 8, False),
    ("rtx 3060 ti", "nvidia", 8, False),
    ("rtx 3060", "nvidia", 12, False),
    ("rtx 3050", "nvidia", 8, False),
    ("rtx 2080 ti", "nvidia", 11, False),
    ("rtx 2060", "nvidia", 6, False),
    ("geforce mx", "nvidia", 2, False),
    ("radeon rx 7900 xtx", "amd", 24, False),
    ("radeon rx 7900 xt", "amd", 20, False),
    ("radeon rx 7800 xt", "amd", 16, False),
    ("radeon rx 7700 xt", "amd", 12, False),
    ("radeon rx 6900 xt", "amd", 16, False),
    ("radeon rx 6800 xt", "amd", 16, False),
    ("radeon rx 6700 xt", "amd", 12, False),
    ("radeon rx 6600", "amd", 8, False),
    ("radeon pro", "amd", None, True),
    ("arc b580", "intel", 12, False),
    ("arc a770", "intel", 16, False),
    ("arc a750", "intel", 8, False),
    ("iris xe", "intel", None, True),
    ("intel uhd", "intel", None, True),
    ("intel hd", "intel", None, True),
]

UMA_VENDORS = {"apple"}


def normalize(name):
    if not name:
        return ""
    text = str(name).lower()
    for token in ["(r)", "(tm)", "(c)", "graphics", "gpu", "device"]:
        text = text.replace(token, " ")
    return " ".join(text.split())


def _trailing_capacity(normalized):
    """Parse a trailing capacity like " 24gb" or " 16g" from a name."""
    tokens = normalized.split()
    for token in reversed(tokens):
        if token.endswith("gb") or token.endswith("g"):
            digits = token[:-2] if token.endswith("gb") else token[:-1]
            if digits.isdigit():
                value = int(digits)
                if 1 <= value <= 512:
                    return value
    return None


def lookup(name):
    """Resolve a GPU adapter name into a capacity guess.

    Returns a dict with matched/vendor/vram_gb/uma/confidence/note. A miss is
    not an error: the caller falls back to asking the user.
    """
    normalized = normalize(name)
    if not normalized:
        return {"matched": False, "vendor": None, "vram_gb": None, "uma": None,
                "confidence": "none", "note": "未提供 GPU 名称"}
    for key, vendor, vram, uma in GPU_TABLE:
        if key in normalized:
            return {
                "matched": True,
                "vendor": vendor,
                "vram_gb": vram,
                "uma": uma or vendor in UMA_VENDORS,
                "confidence": "medium",
                "note": "由 GPU 型号查表得到" + ("（统一内存，容量取决于系统内存）" if uma or vendor in UMA_VENDORS else ""),
            }
    parsed = _trailing_capacity(normalized)
    if parsed:
        return {"matched": True, "vendor": "unknown", "vram_gb": parsed, "uma": False,
                "confidence": "low", "note": "从名称中的容量后缀解析"}
    return {"matched": False, "vendor": "unknown", "vram_gb": None, "uma": None,
            "confidence": "none", "note": "未知型号，请手动填写显存"}


def table():
    return [
        {"key": key, "vendor": vendor, "vram_gb": vram, "uma": uma or vendor in UMA_VENDORS}
        for key, vendor, vram, uma in GPU_TABLE
    ]
