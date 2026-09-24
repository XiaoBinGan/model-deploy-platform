"""Physical estimator.

Borrowed from Hermes-Agent's local_runtime/estimator.py: catalog entries carry
the inputs needed to answer "does it fit and how fast" *before* a download,
and after a download the real GGUF header takes over as the authority.

Every estimate rounds up on purpose. The estimator is advisory; the actual
allocation at launch time and the resident-set touch generation are the truth.
"""
from dataclasses import dataclass

GIB = 1024 ** 3

# KV cache bytes per element relative to f16.
KV_QUANT_SCALE = {
    "f16": 1.0,
    "q8_0": 34 / 32 / 2,   # 34 bytes per 32 elements
    "q4_0": 18 / 32 / 2,
}

# Runtime overhead that is not weights and not KV.
BASE_OVERHEAD_BYTES = 1 * GIB
# Draft/logits buffers scale with vocab; keep a conservative constant.
LOGITS_OVERHEAD_BYTES = 320 * 1024 * 1024

# Memory bandwidth classes (GB/s). Constants, not knobs: they only order
# candidates and gate a floor, they are never shown as a promise.
BANDWIDTH_DISCRETE_GB_S = 1000.0
BANDWIDTH_UMA_GB_S = 210.0
BANDWIDTH_SPILL_GB_S = 80.0

# Comfort floor. Below this a model may still be selectable, but not auto-picked.
COMFORT_DECODE_TOK_S = 20.0

# The promised context floor. Shrinking the window is not an escape hatch.
FLOOR_WINDOW = 64 * 1024
# The target window for agentic sessions (measured from 161 real sessions).
TARGET_WINDOW = 144 * 1024


class PhysicsRefusal(Exception):
    """Only raised when even the most compact build cannot fit."""

    def __init__(self, needed_bytes, available_bytes, message):
        super().__init__(message)
        self.needed_bytes = needed_bytes
        self.available_bytes = available_bytes
        self.message = message

    def to_dict(self):
        return {
            "needed_gb": round(self.needed_bytes / GIB, 2),
            "available_gb": round(self.available_bytes / GIB, 2),
            "message": self.message,
        }


@dataclass
class ModelProfile:
    weights_bytes: int
    layers: int
    kv_bytes_per_token: int
    n_vocab: int
    native_window: int = TARGET_WINDOW

    def ctx_bytes(self, window, kv_quant="q8_0"):
        scale = KV_QUANT_SCALE.get(kv_quant, KV_QUANT_SCALE["f16"])
        return int(self.kv_bytes_per_token * window * scale)

    def overhead_bytes(self, window):
        # Long contexts grow the compute/graph buffers, so scale a little.
        growth = 1.0 + min(window, 262144) / 262144
        return int((BASE_OVERHEAD_BYTES + LOGITS_OVERHEAD_BYTES) * growth)

    def footprint_bytes(self, window, kv_quant="q8_0"):
        return self.weights_bytes + self.ctx_bytes(window, kv_quant) + self.overhead_bytes(window)


def predicted_decode_tok_s(profile, window, kv_quant, budget, zero_spill, decode_fraction=1.0):
    """Pure memory-bandwidth model. Orders candidates and gates the floor.

    MoE models read only their active experts, so decode_fraction < 1 shrinks
    the effective bytes per token. These numbers must never be rendered as a
    throughput promise.
    """
    build_bytes = profile.weights_bytes + profile.ctx_bytes(window, kv_quant)
    if build_bytes <= 0:
        return 0.0
    if not zero_spill:
        bandwidth = BANDWIDTH_SPILL_GB_S
    elif budget.uma:
        bandwidth = BANDWIDTH_UMA_GB_S
    else:
        bandwidth = BANDWIDTH_DISCRETE_GB_S
    effective_gb = (build_bytes / GIB) * max(0.01, decode_fraction)
    return round(bandwidth / effective_gb, 1)


def physics_check(profile, budget, window=FLOOR_WINDOW, kv_quant="q8_0"):
    """Raise PhysicsRefusal when weights + FLOOR window + overhead exceed VRAM+RAM.

    The only hard rejection in the recommender. The remedy is always a smaller
    quant or a smaller model, never "shrink the context".
    """
    needed = profile.footprint_bytes(window, kv_quant)
    # The hard refusal is about *physical* memory, not the planning budget:
    #  * UMA: the unified pool is total_device_bytes; usable is only the
    #    zero-spill target, so a model between the two is spill-visible, not
    #    impossible (B-15).
    #  * discrete: spill lands in system RAM. Free RAM is used when a local
    #    probe reported it; a client profile only reports total RAM, which is
    #    still a hard ceiling.
    if budget.uma:
        available = budget.total_device_bytes
    else:
        available = budget.usable_vram_bytes + (
            budget.ram_available_bytes or budget.ram_total_bytes
        )
    if needed > available:
        raise PhysicsRefusal(
            needed,
            available,
            "即使最紧凑的构建也超过 GPU 与系统内存；请换更小的模型或更小的量化",
        )
    return True


def resident_bytes(profile, budget, window=FLOOR_WINDOW, kv_quant="q8_0"):
    """Bytes that must live on the device for a zero-spill launch."""
    return profile.weights_bytes + profile.ctx_bytes(window, kv_quant) + profile.overhead_bytes(window)


def plan_window(profile, budget, kv_quant="q8_0", floor=FLOOR_WINDOW, target=TARGET_WINDOW):
    """Return the largest window on the ladder that still fits resident.

    Ladder: floor -> x1.5 -> ... -> native cap. The floor is a guarantee; if
    even the floor does not fit resident, spill is reported instead of shrinking
    below the floor. The native cap always wins: a model whose native window is
    below the floor is planned at its native window, never beyond it.
    """
    # B-19: a non-positive floor made int(window * 1.5) a fixed point and the
    # loop never terminated. Keep the floor positive and the step monotonic.
    floor = max(1, int(floor))
    native = profile.native_window if hasattr(profile, "native_window") else None
    cap = native or target
    # B-08: the native window is a hard cap. When a model declares less than
    # the floor, the floor yields to it instead of planning beyond training.
    best = min(floor, cap)
    window = best
    while window <= cap:
        if resident_bytes(profile, budget, window, kv_quant) <= budget.usable_vram_bytes:
            best = window
            step = max(window + 1, int(window * 1.5))
            if step > cap:
                break
            window = step
        else:
            break
    return best
