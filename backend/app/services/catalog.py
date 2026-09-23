"""Model catalog + recommendation resolver.

Borrowed from Hermes-Agent's local_runtime/catalog.py: the catalog is a set of
*physical profiles*, not a hand-maintained "GPU -> model" table. A single pure
function turns (budget, entries) into a recommendation plus a reason_key, and
the UI only renders that reason_key.

Hard rule: only fully resident (zero-spill) models may be auto-recommended.
Models that would spill stay visible and explainable, but require an explicit
user choice.
"""
from dataclasses import dataclass, field, asdict
from typing import Optional

from .estimator import (
    ModelProfile, PhysicsRefusal, physics_check, resident_bytes,
    predicted_decode_tok_s, plan_window, FLOOR_WINDOW, COMFORT_DECODE_TOK_S,
)

GIB = 1024 ** 3

REASON_KEYS = {
    "best-quality-resident": "在完全驻留显存的模型中质量最高",
    "speed-gated-quality": "更高质模型未达速度舒适线，已按速度设门后选出最优",
    "fastest-resident": "没有模型达到速度舒适线，返回驻留中最快的",
    "no-recommendation": "没有任何模型可完全驻留，请显式浏览选择",
    "zero-spill-resident": "可完全驻留 GPU/统一内存",
    "spill-visible": "可运行但会溢出到系统内存，仅支持显式选择",
    "physics-refused": "即使最紧凑构建也放不下",
    "backend-incompatible": "当前后端不支持该模型",
}

VARIANT_PRECISION = {"bf16": 5, "q8_0": 4, "fp8": 3, "awq": 2, "gptq": 2,
                     "mlx-4bit": 1, "q4_k_m": 1}


def _gb(value):
    return int(value * GIB)


def _variants(params_b, cuda=True, gguf=True, awq=True, mlx=None):
    out = []
    if mlx:
        # MLX uses its own weight format, published under the mlx-community org,
        # so this is a separate artifact rather than a backend flag on the GGUF
        # variant. Sized like q4_k_m because both are 4-bit group quantized.
        out.append({"quant": "mlx-4bit", "size_bytes": _gb(params_b * 0.62),
                    "backends": ["mlx"], "validated": True, "repo": mlx})
    if gguf:
        out.append({"quant": "q8_0", "size_bytes": _gb(params_b * 1.10),
                    "backends": ["ollama", "llama.cpp", "transformers"], "validated": True})
        out.append({"quant": "q4_k_m", "size_bytes": _gb(params_b * 0.62),
                    "backends": ["ollama", "llama.cpp", "transformers"], "validated": True})
    if cuda:
        out.append({"quant": "bf16", "size_bytes": _gb(params_b * 2.05),
                    "backends": ["vllm", "sglang"], "validated": True})
        out.append({"quant": "fp8", "size_bytes": _gb(params_b * 1.10),
                    "backends": ["vllm", "sglang"], "validated": True})
        if awq:
            out.append({"quant": "awq", "size_bytes": _gb(params_b * 0.62),
                        "backends": ["vllm", "sglang"], "validated": True})
            out.append({"quant": "gptq", "size_bytes": _gb(params_b * 0.62),
                        "backends": ["vllm", "sglang"], "validated": True})
    return out


@dataclass
class CatalogEntry:
    id: str
    name: str
    params_b: float
    quality: int
    layers: int
    kv_bytes_per_token: int
    n_vocab: int
    native_ctx: int
    capabilities: list
    variants: list
    decode_fraction: float = 1.0
    moe: bool = False
    mtp: bool = False
    min_engine: dict = field(default_factory=dict)
    source: dict = field(default_factory=dict)

    def profile(self, variant):
        return ModelProfile(
            weights_bytes=variant["size_bytes"],
            layers=self.layers,
            kv_bytes_per_token=self.kv_bytes_per_token,
            n_vocab=self.n_vocab,
            native_window=self.native_ctx,
        )

    def to_dict(self):
        d = asdict(self)
        d["reason_keys"] = REASON_KEYS
        return d


@dataclass
class VariantChoice:
    entry: CatalogEntry
    variant: dict
    profile: ModelProfile
    window: int
    kv_quant: str
    zero_spill: bool
    spill_bytes: int
    predicted_tok_s: float
    backend: Optional[str] = None
    reason_key: str = "zero-spill-resident"
    refusal: Optional[dict] = None

    def to_dict(self):
        return {
            "id": self.entry.id,
            "name": self.entry.name,
            "params_b": self.entry.params_b,
            "quality": self.entry.quality,
            "quantization": self.variant["quant"],
            "backend": self.backend,
            "backends": self.variant["backends"],
            "mlx_repo": self.variant.get("repo"),
            "capabilities": self.entry.capabilities,
            "context_length": self.entry.native_ctx,
            "memory_gb": round(self.variant["size_bytes"] / GIB, 2),
            "zero_spill": self.zero_spill,
            "fits": self.refusal is None,
            "spill_gb": round(self.spill_bytes / GIB, 2),
            "planned_window": self.window,
            "kv_quant": self.kv_quant,
            "predicted_decode_tok_s": self.predicted_tok_s,
            "moe": self.entry.moe,
            "mtp": self.entry.mtp,
            "source": self.entry.source,
            "reason_key": self.reason_key,
            "reason": REASON_KEYS.get(self.reason_key, self.reason_key),
            "refusal": self.refusal,
        }


def select_variant(entry, budget, backend=None, floor=FLOOR_WINDOW, kv_quant="q8_0"):
    """Pick the best variant of one entry for this budget.

    Returns a VariantChoice. When nothing fits at all the choice carries a
    refusal instead of raising, so the row stays visible and explainable.
    """
    candidates = []
    refusals = []
    for variant in entry.variants:
        if backend and backend not in variant["backends"]:
            continue
        profile = entry.profile(variant)
        try:
            physics_check(profile, budget, floor, kv_quant)
        except PhysicsRefusal as exc:
            refusals.append(exc)
            continue
        resident = resident_bytes(profile, budget, floor, kv_quant)
        zero_spill = resident <= budget.usable_vram_bytes
        window = plan_window(profile, budget, kv_quant) if zero_spill else floor
        candidates.append(VariantChoice(
            entry=entry, variant=variant, profile=profile, window=window,
            kv_quant=kv_quant, zero_spill=zero_spill,
            spill_bytes=max(0, resident - budget.usable_vram_bytes) if not zero_spill else 0,
            predicted_tok_s=predicted_decode_tok_s(profile, window, kv_quant, budget, zero_spill, entry.decode_fraction),
            backend=backend,
        ))

    if not candidates:
        if not refusals:
            return VariantChoice(
                entry=entry, variant={"quant": "n/a", "size_bytes": 0, "backends": [], "validated": False},
                profile=entry.profile({"size_bytes": 0}), window=floor, kv_quant=kv_quant,
                zero_spill=False, spill_bytes=0, predicted_tok_s=0.0, backend=backend,
                reason_key="backend-incompatible", refusal=None,
            )
        worst = max(refusals, key=lambda exc: exc.available_bytes - exc.needed_bytes)
        return VariantChoice(
            entry=entry, variant={"quant": "n/a", "size_bytes": 0, "backends": [], "validated": False},
            profile=entry.profile({"size_bytes": 0}), window=floor, kv_quant=kv_quant,
            zero_spill=False, spill_bytes=0, predicted_tok_s=0.0, backend=backend,
            reason_key="physics-refused", refusal=worst.to_dict(),
        )

    resident_candidates = [c for c in candidates if c.zero_spill]
    if resident_candidates:
        # Prefer the highest precision that still clears the comfort line; only
        # drop precision when it is the price of a comfortable decode speed.
        chosen = max(resident_candidates, key=lambda c: (
            1 if c.predicted_tok_s >= COMFORT_DECODE_TOK_S else 0,
            VARIANT_PRECISION.get(c.variant["quant"], 0),
        ))
        chosen.reason_key = "zero-spill-resident"
        return chosen

    # Nothing resident: keep the smallest-spill option, but mark it explicit-only.
    chosen = min(candidates, key=lambda c: c.spill_bytes)
    chosen.reason_key = "spill-visible"
    return chosen


def recommended_entry(budget, choices):
    """Pure resolver: (budget, per-entry choices) -> (choice, reason_key).

    Only zero-spill choices are eligible. Speed is a gate, then quality decides.
    """
    eligible = [c for c in choices if c.zero_spill and c.refusal is None]
    if not eligible:
        return None, "no-recommendation"

    fast = [c for c in eligible if c.predicted_tok_s >= COMFORT_DECODE_TOK_S]
    if fast:
        best = max(fast, key=lambda c: (c.entry.quality, c.profile.weights_bytes))
        gated = [c for c in eligible
                 if c.predicted_tok_s < COMFORT_DECODE_TOK_S and c.entry.quality > best.entry.quality]
        return best, ("speed-gated-quality" if gated else "best-quality-resident")

    best = max(eligible, key=lambda c: c.predicted_tok_s)
    return best, "fastest-resident"


def mlx_repo(huggingface_id):
    """Map a HuggingFace id to its mlx-community 4bit counterpart.

    The org republishes weights under the source model's own name with a -4bit
    suffix, so this is a convention rather than a lookup table. Every derived id
    in CATALOG is checked against the Hub by tests/test_mlx_catalog.py, which is
    what keeps the convention from silently rotting.
    """
    if not huggingface_id or "/" not in huggingface_id:
        return None
    return "mlx-community/" + huggingface_id.split("/", 1)[1] + "-4bit"


def _e(params_b, quality, layers, kv_kib, ctx, caps, cuda=True, gguf=True, awq=True,
       decode_fraction=1.0, moe=False, mtp=False, source=None, vocab=152064):
    name = source.get("label") if source else None
    return CatalogEntry(
        id=source["id"], name=name or source["id"], params_b=params_b, quality=quality,
        layers=layers, kv_bytes_per_token=int(kv_kib * 1024), n_vocab=vocab,
        native_ctx=ctx, capabilities=caps,
        variants=_variants(params_b, cuda, gguf, awq, mlx=(source or {}).get("mlx")),
        decode_fraction=decode_fraction, moe=moe, mtp=mtp, source=source or {},
    )


def _s(id_, label, ollama=None, hf=None, mlx="auto"):
    # mlx="auto" derives the repo; pass mlx=None for entries whose HuggingFace id
    # is already a CUDA-specific artifact (an AWQ repo has no mlx counterpart).
    return {"id": id_, "label": label, "ollama": ollama, "huggingface": hf,
            "mlx": mlx_repo(hf) if mlx == "auto" else mlx}


CATALOG = [
    _e(0.5, 45, 24, 16, 32768, ["chat", "chinese"], cuda=False, source=_s("qwen2.5-0.5b", "Qwen2.5 0.5B · GGUF", "qwen2.5:0.5b", "Qwen/Qwen2.5-0.5B-Instruct")),
    _e(1.0, 48, 16, 24, 131072, ["chat", "english", "code"], cuda=False, source=_s("llama3.2-1b", "Llama 3.2 1B · GGUF", "llama3.2:1b", "meta-llama/Llama-3.2-1B-Instruct")),
    _e(1.5, 55, 28, 32, 32768, ["chat", "chinese", "code"], cuda=False, source=_s("qwen2.5-1.5b", "Qwen2.5 1.5B · GGUF", "qwen2.5:1.5b", "Qwen/Qwen2.5-1.5B-Instruct")),
    _e(3.0, 60, 28, 48, 131072, ["chat", "english", "vision"], cuda=False, source=_s("llama3.2-3b", "Llama 3.2 3B · GGUF", "llama3.2:3b", "meta-llama/Llama-3.2-3B-Instruct")),
    _e(3.0, 62, 36, 48, 32768, ["chat", "chinese", "code", "tool_calling"], cuda=False, source=_s("qwen2.5-3b", "Qwen2.5 3B · GGUF", "qwen2.5:3b", "Qwen/Qwen2.5-3B-Instruct")),
    _e(4.0, 66, 34, 64, 131072, ["chat", "vision", "english"], source=_s("gemma3-4b", "Gemma 3 4B · GGUF", "gemma3:4b", "google/gemma-3-4b-it")),
    _e(3.8, 68, 32, 56, 131072, ["chat", "code", "english", "reasoning"], source=_s("phi4-mini", "Phi-4-mini · GGUF", "phi4-mini", "microsoft/Phi-4-mini-instruct")),
    _e(7.0, 70, 32, 112, 32768, ["chat", "english", "code"], source=_s("mistral-7b", "Mistral 7B · GGUF", "mistral:7b", "mistralai/Mistral-7B-Instruct-v0.3")),
    _e(7.0, 72, 28, 112, 32768, ["chat", "chinese", "code", "tool_calling"], source=_s("qwen2.5-7b", "Qwen2.5 7B · GGUF", "qwen2.5:7b", "Qwen/Qwen2.5-7B-Instruct")),
    _e(7.0, 73, 28, 112, 32768, ["code", "chat", "chinese"], source=_s("qwen2.5-coder-7b", "Qwen2.5-Coder 7B · GGUF", "qwen2.5-coder:7b", "Qwen/Qwen2.5-Coder-7B-Instruct")),
    _e(8.0, 75, 36, 128, 32768, ["chat", "reasoning", "chinese", "tool_calling"], source=_s("qwen3-8b", "Qwen3 8B · GGUF", "qwen3:8b", "Qwen/Qwen3-8B")),
    _e(7.0, 74, 28, 112, 32768, ["reasoning", "chat", "chinese"], source=_s("deepseek-r1-7b", "DeepSeek-R1 7B · GGUF", "deepseek-r1:7b", "deepseek-ai/DeepSeek-R1-Distill-Qwen-7B")),
    _e(8.0, 74, 32, 128, 32768, ["chat", "reasoning", "chinese", "code"], source=_s("internlm3-8b", "InternLM3 8B · GGUF", None, "internlm/internlm3-8b-instruct")),
    _e(8.0, 76, 32, 128, 131072, ["chat", "tool_calling", "english"], source=_s("llama3.1-8b", "Llama 3.1 8B · GGUF", "llama3.1:8b", "meta-llama/Llama-3.1-8B-Instruct")),
    _e(7.0, 74, 28, 112, 32768, ["chat", "vision", "chinese"], source=_s("qwen2.5-vl-7b", "Qwen2.5-VL 7B · GGUF", "qwen2.5vl:7b", "Qwen/Qwen2.5-VL-7B-Instruct")),
    _e(12.0, 78, 40, 160, 131072, ["chat", "english", "code", "tool_calling"], source=_s("mistral-nemo-12b", "Mistral Nemo 12B · GGUF", "mistral-nemo", "mistralai/Mistral-Nemo-Instruct-2407")),
    _e(14.0, 80, 48, 200, 32768, ["chat", "chinese", "tool_calling"], source=_s("qwen2.5-14b", "Qwen2.5 14B · GGUF", "qwen2.5:14b", "Qwen/Qwen2.5-14B-Instruct")),
    _e(14.0, 82, 40, 200, 32768, ["chat", "reasoning", "chinese", "tool_calling"], source=_s("qwen3-14b", "Qwen3 14B · GGUF", "qwen3:14b", "Qwen/Qwen3-14B")),
    _e(30.0, 84, 48, 96, 262144, ["chat", "reasoning", "chinese", "tool_calling"], decode_fraction=0.12, moe=True, source=_s("qwen3-30b-a3b", "Qwen3 30B-A3B · MoE GGUF", "qwen3:30b", "Qwen/Qwen3-30B-A3B")),
    _e(32.0, 86, 64, 320, 32768, ["chat", "chinese", "tool_calling", "long_context"], source=_s("qwen2.5-32b", "Qwen2.5 32B · GGUF", "qwen2.5:32b", "Qwen/Qwen2.5-32B-Instruct")),
    _e(32.0, 88, 64, 320, 32768, ["chat", "reasoning", "chinese", "tool_calling"], source=_s("qwen3-32b", "Qwen3 32B · GGUF", "qwen3:32b", "Qwen/Qwen3-32B")),
    _e(32.0, 87, 64, 320, 32768, ["reasoning", "chat", "chinese"], source=_s("deepseek-r1-32b", "DeepSeek-R1 32B · GGUF", "deepseek-r1:32b", "deepseek-ai/DeepSeek-R1-Distill-Qwen-32B")),
    # CUDA-only extras (no GGUF variant)
    _e(8.0, 74, 32, 128, 32768, ["chat", "vision", "chinese"], gguf=False, source=_s("qwen2.5-vl-7b-cuda", "Qwen2.5-VL 7B · AWQ/GPTQ", None, "Qwen/Qwen2.5-VL-7B-Instruct-AWQ", mlx=None)),
    _e(3.8, 66, 32, 56, 131072, ["chat", "code", "english", "reasoning"], gguf=False, source=_s("phi-4-mini-cuda", "Phi-4-mini · AWQ/GPTQ", None, "microsoft/Phi-4-mini-instruct", mlx=None)),
]


def eligible_entries(backend=None, engine_versions=None):
    """Engine gate: too-old entries stay visible but are not recommendable."""
    out = []
    for entry in CATALOG:
        if backend and not any(backend in v["backends"] for v in entry.variants):
            out.append((entry, False))
            continue
        out.append((entry, True))
    return out


def resolve(budget, backend=None, entries=None):
    """Run the resolver over the catalog for one budget/backend."""
    entries = entries if entries is not None else CATALOG
    choices = []
    for entry in entries:
        if backend and not any(backend in v["backends"] for v in entry.variants):
            choices.append(VariantChoice(
                entry=entry, variant={"quant": "n/a", "size_bytes": 0, "backends": [], "validated": False},
                profile=entry.profile({"size_bytes": 0}), window=FLOOR_WINDOW, kv_quant="q8_0",
                zero_spill=False, spill_bytes=0, predicted_tok_s=0.0, backend=backend,
                reason_key="backend-incompatible",
            ))
            continue
        choices.append(select_variant(entry, budget, backend=backend))
    pick, reason_key = recommended_entry(budget, choices)
    return {"choices": choices, "pick": pick, "reason_key": reason_key}
