"""Minimal OpenAI-compatible inference server using transformers.
Loads model once at startup, serves /v1/chat/completions and /v1/models.
Intended for MVP validation with small models (<=3B)."""
import argparse, json, time, uuid, sys, os

from pathlib import Path


def sse_chunks(model_name, reply, completion_id=None, created=None):
    """OpenAI-compatible SSE frames for a completed reply.

    `model.generate` is not incremental here, so the whole reply is delivered as
    one content delta. What streaming clients actually parse is the framing: one
    JSON object per `data:` line, terminated by `data: [DONE]`. B-20 in
    docs/qa-findings-backend.md: the old code returned a single
    application/json body, which any SSE client rejects.
    """
    completion_id = completion_id or f"chatcmpl-{uuid.uuid4().hex[:8]}"
    created = int(time.time() if created is None else created)
    base = {"id": completion_id, "object": "chat.completion.chunk",
            "created": created, "model": model_name}

    def frame(choices):
        payload = dict(base, choices=choices)
        return "data: " + json.dumps(payload, ensure_ascii=False) + "\n\n"

    yield frame([{"index": 0, "delta": {"role": "assistant"}, "finish_reason": None}])
    yield frame([{"index": 0, "delta": {"content": reply}, "finish_reason": None}])
    yield frame([{"index": 0, "delta": {}, "finish_reason": "stop"}])
    yield "data: [DONE]\n\n"


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--model-path", required=True)
    parser.add_argument("--port", type=int, default=8000)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--dtype", default="bfloat16")
    args = parser.parse_args()

    import torch
    from transformers import AutoModelForCausalLM, AutoTokenizer

    dtype_map = {"bfloat16": torch.bfloat16, "float16": torch.float16, "float32": torch.float32}
    dtype = dtype_map.get(args.dtype, torch.bfloat16)
    device = "cuda" if torch.cuda.is_available() else "cpu"

    print(f"[transformers_server] Loading {args.model_path} dtype={args.dtype} device={device}", flush=True)
    tokenizer = AutoTokenizer.from_pretrained(args.model_path, trust_remote_code=True)
    model = AutoModelForCausalLM.from_pretrained(
        args.model_path, torch_dtype=dtype, device_map=device, trust_remote_code=True
    )
    model.eval()
    model_name = Path(args.model_path).name
    print(f"[transformers_server] Model loaded. Starting server on {args.host}:{args.port}", flush=True)

    from fastapi import FastAPI, Request
    from fastapi.responses import StreamingResponse
    import uvicorn

    app = FastAPI(title="transformers inference server")

    @app.get("/health")
    def health():
        return {"status": "ok"}

    @app.get("/v1/models")
    def models():
        return {"object": "list", "data": [{"id": model_name, "object": "model", "owned_by": "local"}]}

    @app.post("/v1/chat/completions")
    async def chat(request: Request):
        body = await request.json()
        messages = body.get("messages", [])
        stream = body.get("stream", False)
        max_tokens = body.get("max_tokens", 512)
        temperature = body.get("temperature", 0.7)

        text = tokenizer.apply_chat_template(messages, tokenize=False, add_generation_prompt=True)
        inputs = tokenizer(text, return_tensors="pt").to(device)

        with torch.no_grad():
            outputs = model.generate(
                **inputs,
                max_new_tokens=max_tokens,
                temperature=max(temperature, 0.01),
                do_sample=temperature > 0,
                pad_token_id=tokenizer.eos_token_id,
            )
        generated = outputs[0][inputs["input_ids"].shape[1]:]
        reply = tokenizer.decode(generated, skip_special_tokens=True)

        if stream:
            # Real SSE framing: one `data:` line per chunk, then `data: [DONE]`.
            return StreamingResponse(
                sse_chunks(model_name, reply),
                media_type="text/event-stream",
                headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
            )

        return {
            "id": f"chatcmpl-{uuid.uuid4().hex[:8]}",
            "object": "chat.completion",
            "model": model_name,
            "choices": [{
                "index": 0,
                "message": {"role": "assistant", "content": reply},
                "finish_reason": "stop",
            }],
            "usage": {"prompt_tokens": inputs["input_ids"].shape[1], "completion_tokens": len(generated), "total_tokens": inputs["input_ids"].shape[1] + len(generated)},
        }

    uvicorn.run(app, host=args.host, port=args.port, log_level="info")

if __name__ == "__main__":
    main()
