"""The CSP nonce the frontend is served with.

The page ships a placeholder rather than a value. If a server ever serves the
file without substituting it, the CSP degrades to a fixed, public nonce - and
this repo is public, so an attacker who can inject markup could simply reuse
it. That is why the substitution both randomises per response AND fails loudly
when the placeholder is missing. These tests pin down both halves.
"""
import re
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app import main

META = re.compile(r"script-src 'nonce-([^']+)'")
TAG = re.compile(r'<script nonce="([^"]+)"')


@pytest.fixture
def client():
    return TestClient(main.app, raise_server_exceptions=False)


@pytest.mark.parametrize("path", ["/", "/index.html"])
def test_index_is_served_with_a_nonce(client, path):
    r = client.get(path)
    assert r.status_code == 200
    body = r.text
    assert "{{CSP_NONCE}}" not in body, "占位符没被替换，CSP 会退化成固定 nonce"
    meta, tag = META.search(body), TAG.search(body)
    assert meta and tag, "meta 或 script 标签上没有 nonce"
    # 两者必须一致，否则自己的脚本也会被 CSP 拒掉（整页不能用）。
    assert meta.group(1) == tag.group(1)


def test_nonce_changes_on_every_response(client):
    """固定 nonce 等于没 nonce：这个仓库是公开的，字符串人人可读。"""
    seen = {META.search(client.get("/").text).group(1) for _ in range(8)}
    # 8 次里出现重复说明根本没随机（不是概率问题：token_urlsafe(16) 撞不上）。
    assert len(seen) == 8, f"nonce 在 8 次响应里只出现 {len(seen)} 个不同值"


def test_missing_placeholder_fails_loudly(client, tmp_path, monkeypatch):
    """宁可 500，也不要静默返回一个 CSP 形同虚设的页面。"""
    broken = tmp_path / "index.html"
    broken.write_text("<html><script nonce=\"x\"></script></html>", encoding="utf-8")
    monkeypatch.setattr(main, "frontend_dir", tmp_path)
    r = client.get("/")
    assert r.status_code == 500
    assert "nonce" in r.text.lower()


def test_render_index_rejects_a_partial_placeholder(tmp_path, monkeypatch):
    """只替换掉一处同样是坏的：剩下的那处会变成页面上可见的字面量。"""
    (tmp_path / "index.html").write_text(
        "<meta content=\"script-src 'nonce-{{CSP_NONCE}}'\"><script nonce=\"x\">",
        encoding="utf-8",
    )
    monkeypatch.setattr(main, "frontend_dir", tmp_path)
    with pytest.raises(main.HTTPException):
        main._render_index()
