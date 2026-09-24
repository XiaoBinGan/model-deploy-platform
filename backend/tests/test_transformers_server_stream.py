"""transformers_server stream=true must speak SSE (B-20).

The pre-fix code returned one application/json body, so both tests fail.
"""
import inspect
import json

from app.runtimes import transformers_server as ts


def test_stream_true_produces_sse_frames():
    frames = list(ts.sse_chunks("test-model", "hello", completion_id="chatcmpl-test", created=0))
    assert frames[-1] == "data: [DONE]\n\n"
    payloads = []
    for frame in frames[:-1]:
        assert frame.startswith("data: ")
        assert frame.endswith("\n\n")
        assert frame.count("\n") == 2  # exactly one JSON line plus the blank separator
        payloads.append(json.loads(frame[len("data: "):-2]))
    assert all(payload["object"] == "chat.completion.chunk" for payload in payloads)
    assert all(payload["id"] == "chatcmpl-test" for payload in payloads)
    assert payloads[0]["choices"][0]["delta"] == {"role": "assistant"}
    assert payloads[1]["choices"][0]["delta"]["content"] == "hello"
    assert payloads[-1]["choices"][0]["finish_reason"] == "stop"


def test_stream_branch_returns_event_stream_not_json():
    source = inspect.getsource(ts.main)
    assert "text/event-stream" in source
    assert "StreamingResponse" in source
    assert "JSONResponse" not in source
