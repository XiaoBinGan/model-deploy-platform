"""Windows probe paths.

The generated probe script is a plain Python file that runs on the user's
machine, so these tests execute it with a fake platform module and a fake
subprocess.run. That exercises the real parsing logic on every OS, which is the
only way to cover the Windows branch without a Windows machine.
"""
import contextlib
import io
import json
import types

from app.services import profiles


def _fake_run(mapping):
    """Build a subprocess.run stand-in keyed on a substring of the command."""
    def impl(args, **kwargs):
        cmd = " ".join(args)
        for needle, value in mapping:
            if needle in cmd:
                return types.SimpleNamespace(stdout=value, returncode=0)
        return types.SimpleNamespace(stdout="", returncode=1)
    return impl


def _run_probe(system, run_impl):
    """Execute PROBE_SCRIPT with the imports replaced by fakes.

    The script imports json/os/platform/subprocess itself, which would shadow
    anything injected into globals, so the import lines are dropped and the
    names are supplied by the exec namespace instead.
    """
    source = "\n".join(
        line for line in profiles.PROBE_SCRIPT.splitlines() if not line.startswith("import ")
    )
    namespace = {
        "json": json,
        "os": types.SimpleNamespace(cpu_count=lambda: 16),
        "platform": types.SimpleNamespace(system=lambda: system, machine=lambda: "AMD64"),
        "subprocess": types.SimpleNamespace(run=run_impl),
    }
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        exec(compile(source, "<probe>", "exec"), namespace)
    return json.loads(buf.getvalue())


def test_windows_probe_reports_win32_not_windows():
    """platform.system() says Windows; every consumer spells it win32."""
    data = _run_probe("Windows", _fake_run([
        ("TotalPhysicalMemory", "34359738368"),
        ("Get-ItemProperty", "NVIDIA GeForce RTX 4090|25769803776"),
    ]))
    assert data["platform"] == "win32"


def test_windows_probe_reads_ram_from_cim_not_proc_meminfo():
    """Windows used to fall into the /proc/meminfo branch and report None."""
    data = _run_probe("Windows", _fake_run([
        ("TotalPhysicalMemory", "34359738368"),
        ("Get-ItemProperty", "NVIDIA GeForce RTX 4090|25769803776"),
    ]))
    assert data["ram_gb"] == 32.0


def test_windows_probe_parses_registry_qword_vram():
    """AdapterRAM truncates above 4GB, so the REG_QWORD is the real source."""
    data = _run_probe("Windows", _fake_run([
        ("TotalPhysicalMemory", "34359738368"),
        ("Get-ItemProperty",
         "NVIDIA GeForce RTX 4090|25769803776\n"
         "Intel(R) Iris(R) Xe Graphics|1073741824"),
    ]))
    gpus = data["gpus"]
    assert len(gpus) == 2
    assert gpus[0]["name"] == "NVIDIA GeForce RTX 4090"
    assert gpus[0]["vram_gb"] == 24.0
    assert gpus[0]["vendor"] == "nvidia"
    # A non-NVIDIA adapter must not be mislabelled as nvidia.
    assert gpus[1]["vendor"] == "unknown"
    assert gpus[1]["vram_gb"] == 1.0


def test_windows_probe_prefers_nvidia_smi_when_present():
    data = _run_probe("Windows", _fake_run([
        ("nvidia-smi", "NVIDIA GeForce RTX 5090, 32768"),
        ("TotalPhysicalMemory", "68719476736"),
    ]))
    assert data["gpus"][0]["name"] == "NVIDIA GeForce RTX 5090"
    assert data["gpus"][0]["vram_gb"] == 32.0
    assert data["ram_gb"] == 64.0


def test_linux_probe_still_reports_linux():
    """Regression: the Windows branch must not disturb the other platforms."""
    data = _run_probe("Linux", _fake_run([("nvidia-smi", "")]))
    assert data["platform"] == "linux"


def test_probe_command_uses_powershell_on_windows():
    assert profiles.probe_command("http://x:8790", "win32") == \
        "irm http://x:8790/api/hardware/probe.ps1 | iex"
    # The script reports "windows" on older builds; accept both spellings.
    assert "probe.ps1" in profiles.probe_command("http://x:8790", "windows")
    assert "probe.py" in profiles.probe_command("http://x:8790", "darwin")


def test_probe_command_endpoint_dispatches_on_platform():
    """The endpoint used to pass the whole user-agent as the platform name, so
    the dispatch never fired and every OS got the curl+python3 command."""
    from fastapi.testclient import TestClient
    from app.main import app

    client = TestClient(app)
    win = client.get("/api/hardware/probe-command", params={"platform": "win32"}).json()
    assert win["platform"] == "win32"
    assert "probe.ps1" in win["command"]

    mac = client.get("/api/hardware/probe-command", params={"platform": "darwin"}).json()
    assert "probe.py" in mac["command"]

    # No explicit platform: fall back to sniffing the user-agent.
    sniffed = client.get(
        "/api/hardware/probe-command",
        headers={"user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"},
    ).json()
    assert sniffed["platform"] == "win32"
    assert "probe.ps1" in sniffed["command"]


def test_powershell_probe_is_served():
    from fastapi.testclient import TestClient
    from app.main import app

    body = TestClient(app).get("/api/hardware/probe.ps1").text
    assert "qwMemorySize" in body
    assert "TotalPhysicalMemory" in body


def test_powershell_probe_needs_no_python():
    script = profiles.probe_script_ps1()
    assert "qwMemorySize" in script, "must read the REG_QWORD"
    assert "TotalPhysicalMemory" in script
    # Comments explain why AdapterRAM is avoided; only real code must not use it.
    code = [l for l in script.splitlines() if not l.strip().startswith("#")]
    assert not any("AdapterRAM" in l for l in code), "must not read the truncating uint32"
    assert not any("python" in l.lower() for l in code), "must not depend on Python"
