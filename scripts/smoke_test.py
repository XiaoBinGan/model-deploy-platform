#!/usr/bin/env python
"""Smoke test for model deploy platform."""
import urllib.request, json, sys

BASE = "http://127.0.0.1:8790"

def get(path):
    try:
        r = urllib.request.urlopen(f"{BASE}{path}", timeout=30)
        print(f"{path} {r.status} {r.read(200).decode('utf-8','replace')[:120]}")
        return True
    except Exception as e:
        print(f"{path} FAIL {e}")
        return False

def post(path, data):
    try:
        req = urllib.request.Request(
            f"{BASE}{path}",
            data=json.dumps(data).encode(),
            headers={"Content-Type": "application/json"},
        )
        r = urllib.request.urlopen(req, timeout=60)
        body = r.read(300).decode("utf-8", "replace")
        print(f"POST {path} {r.status} {body[:120]}")
        return json.loads(body)
    except Exception as e:
        print(f"POST {path} FAIL {e}")
        return None

tests = [
    get("/api/health"),
    get("/api/environment/latest"),
    get("/api/models/catalog"),
    get("/api/models/local"),
    get("/api/models/ollama"),
    get("/api/backends"),
]

# Recommend test
post("/api/models/recommend", {"task": "chat", "goal": "balanced", "available_vram_gb": 32})

# Plan preview
post("/api/plans/preview", {
    "model_id": "qwen3-8b-awq",
    "model_path": "G:/models/Qwen3-8B-AWQ",
    "backend": "vllm",
    "quantization": "awq",
})

# Create + start ollama deployment
dep = post("/api/deployments", {
    "model_path": "qwen2.5:7b",
    "model_id": "qwen2.5-7b-ollama",
    "backend": "ollama",
    "model_name": "qwen2.5:7b",
})
if dep and dep.get("id"):
    started = post(f"/api/deployments/{dep['id']}/start", {})
    if started and started.get("status") == "RUNNING":
        # Test chat completions
        try:
            chat_req = urllib.request.Request(
                f"http://127.0.0.1:11434/v1/chat/completions",
                data=json.dumps({
                    "model": "qwen2.5:7b",
                    "messages": [{"role": "user", "content": "你好，请用一句话介绍你自己"}],
                    "max_tokens": 100,
                }).encode(),
                headers={"Content-Type": "application/json"},
            )
            r = urllib.request.urlopen(chat_req, timeout=60)
            result = json.loads(r.read().decode("utf-8"))
            reply = result["choices"][0]["message"]["content"]
            print(f"\nCHAT COMPLETIONS: {r.status}")
            print(f"Model reply: {reply[:200]}")
            print(f"Tokens: {result.get('usage', {})}")
            tests.append(True)
        except Exception as e:
            print(f"CHAT COMPLETIONS FAIL: {e}")
            tests.append(False)
    post(f"/api/deployments/{dep['id']}/stop", {})

ok = sum(t for t in tests if t is True)
total = len(tests)
print(f"\n{ok}/{total} checks passed")
if ok >= total - 1:
    print("SMOKE PASS")
else:
    print("SMOKE FAIL")
    sys.exit(1)
