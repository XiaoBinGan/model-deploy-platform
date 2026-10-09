"""Windows-specific regressions found on a real Windows 10 box.

Each test here corresponds to a defect that only showed up when the code ran on
Windows; the point of keeping them is that none of them is detectable on macOS,
which is where the rest of the suite was written.
"""
import json
import pathlib
import re
import sys

import pytest

from app.services import deployments


def test_windows_volume_host_path_is_absolute(tmp_path):
    """`C:\\models` is an absolute path; it used to be rejected as if it were not.

    The control plane cannot know the docker host's OS, so both spellings must be
    accepted. The container side stays Linux-only.
    """
    win = "C:\\models"
    if not pathlib.PureWindowsPath(win).is_absolute():
        raise AssertionError("the fixture itself is wrong")
    vols = deployments._normalize_docker_options(
        image=None, gpus=None, volumes=[{"host": win, "container": "/models"}], extra_args=None
    )["volumes"]
    assert vols == [{"host": win, "container": "/models", "ro": False}]


@pytest.mark.parametrize("host", ["/srv/models", "C:\\models", "C:/models", "\\\\server\\share"])
def test_volume_host_accepts_both_absolute_spellings(host):
    vols = deployments._normalize_docker_options(
        image=None, gpus=None, volumes=[{"host": host, "container": "/models"}], extra_args=None
    )["volumes"]
    assert vols[0]["host"] == host


@pytest.mark.parametrize("host", ["models", "./models", "C:models", ""])
def test_volume_host_still_rejects_relative_paths(host):
    with pytest.raises(deployments.InvalidDeploymentRequest):
        deployments._normalize_docker_options(
            image=None, gpus=None, volumes=[{"host": host, "container": "/models"}], extra_args=None
        )


@pytest.mark.parametrize("container", ["models", "C:\\models", "/models:ro"])
def test_volume_container_must_be_a_linux_absolute_path(container):
    """The container side is always Linux: a drive letter there is not a path."""
    with pytest.raises(deployments.InvalidDeploymentRequest):
        deployments._normalize_docker_options(
            image=None, gpus=None, volumes=[{"host": "/srv/m", "container": container}], extra_args=None
        )


def test_windows_ram_is_read_when_proc_meminfo_is_absent(monkeypatch):
    """Windows has no /proc/meminfo, so _os_ram() returned (0, 0).

    A machine without an NVIDIA card was then budgeted as having no memory at
    all, and the resolver refused every model.
    """
    from app.services import hardware

    values = {
        "TotalPhysicalMemory": "34125086720",
        "FreePhysicalMemory": "18350000",  # KiB, i.e. ~17.5 GiB free
    }
    monkeypatch.setattr(hardware, "_run", lambda args: values.get(
        "TotalPhysicalMemory" if "TotalPhysicalMemory" in args[-1] else "FreePhysicalMemory", ""))
    total, available = hardware._os_ram()
    assert total == 34125086720
    assert available == 18350000 * 1024
    assert 0 < available < total


def test_windows_ram_falls_back_when_the_free_counter_is_unreadable(monkeypatch):
    from app.services import hardware

    monkeypatch.setattr(hardware, "_run", lambda args: "34359738368" if "TotalPhysicalMemory" in args[-1] else "")
    total, available = hardware._os_ram()
    assert total == 34359738368
    assert available == total // 2, "an unreadable free counter must not mean zero available"


def test_windows_ram_reports_zero_when_total_is_unreadable(monkeypatch):
    from app.services import hardware

    monkeypatch.setattr(hardware, "_run", lambda args: "")
    assert hardware._os_ram() == (0, 0)


def test_posix_ram_path_is_untouched(monkeypatch):
    """sys.platform is not win32 on the dev/CI machines, so the old path still runs."""
    from app.services import hardware

    monkeypatch.setattr(hardware.sys, "platform", "linux")
    monkeypatch.setattr(hardware, "_sysctl_int", lambda name: 0)
    real_open = open

    def fake_open(path, *a, **kw):
        if str(path) == "/proc/meminfo":
            import io
            return io.StringIO("MemTotal:       32768000 kB\nMemAvailable:   16000000 kB\n")
        return real_open(path, *a, **kw)

    monkeypatch.setattr("builtins.open", fake_open)
    total, available = hardware._os_ram()
    assert total == 32768000 * 1024
    assert available == 16000000 * 1024


def test_no_source_file_relies_on_the_locale_encoding_to_read_source():
    """path.read_text() with no encoding follows the locale.

    On Chinese Windows that is cp936, and reading a UTF-8 source file with
    Chinese text in it raised UnicodeDecodeError. Every such call in the test
    suite must pass encoding="utf-8" explicitly.
    """
    root = pathlib.Path(__file__).resolve().parent
    offenders = []
    for path in list(root.rglob("*.py")) + list((root.parent / "app").rglob("*.py")):
        if path.resolve() == pathlib.Path(__file__).resolve():
            # This checker necessarily contains the pattern it looks for.
            continue
        text = path.read_text(encoding="utf-8")
        for n, line in enumerate(text.splitlines(), 1):
            if re.search(r"\.read_text\(\s*\)", line) or re.search(r"\.read_text\(\s*encoding\s*=\s*(?![\"']utf)", line):
                offenders.append(f"{path.name}:{n}")
    assert offenders == [], f"read_text() 必须显式指定 encoding='utf-8'：{offenders}"


def test_desktop_child_output_is_decoded_with_the_console_code_page():
    """Windows console programs emit code-page bytes, not UTF-8.

    deploy.js used String(buf), which decodes as UTF-8 and turned every Chinese
    line from `ollama pull` into replacement characters.
    """
    root = pathlib.Path(__file__).resolve().parents[2] / "desktop"
    src = (root / "deploy.js").read_text(encoding="utf-8")
    assert "function decodeChunk(" in src
    bad = 'String(buf).replace(/\\r/g, "")'
    assert bad not in src, "仍有把子进程输出按 UTF-8 解的调用点"
    assert "WINDOWS_OEM_ENCODING" in src


# --- environment.scan() on Windows -------------------------------------------
# Both defects below were visible on the real Windows box: memory.total_gb was
# null on every scan, and WSL2 reported "installed" because wsl.exe exists as an
# inbox stub even when the optional component is missing.


def test_environment_reports_windows_memory_via_cim(monkeypatch):
    """/proc/meminfo and sysctl both miss on Windows, so scan() returned null."""
    from app.services import environment

    monkeypatch.setattr(environment.platform, "system", lambda: "Windows")
    monkeypatch.setattr(environment.platform, "machine", lambda: "AMD64")
    monkeypatch.setattr(environment, "nvidia_devices", lambda: [])

    def fake_run(args):
        if args and args[0] == "powershell":
            return "34115244032"          # 31.8 GiB, as CIM actually returns
        return ""

    monkeypatch.setattr(environment, "run", fake_run)
    monkeypatch.setattr(environment, "wsl_status", lambda: "ready")
    got = environment.scan()
    assert got["memory"]["total_gb"] == 31.8


def test_environment_windows_memory_survives_a_failed_probe(monkeypatch):
    from app.services import environment

    monkeypatch.setattr(environment.platform, "system", lambda: "Windows")
    monkeypatch.setattr(environment.platform, "machine", lambda: "AMD64")
    monkeypatch.setattr(environment, "nvidia_devices", lambda: [])
    monkeypatch.setattr(environment, "run", lambda args: "")   # command failed
    monkeypatch.setattr(environment, "wsl_status", lambda: "ready")
    assert environment.scan()["memory"]["total_gb"] is None


@pytest.mark.parametrize("state,installed,usable,status", [
    ("ready",   True,  True,  "PASS"),
    ("present", True,  False, "WARNING"),   # wsl.exe stub, component missing
    ("absent",  False, False, "WARNING"),
])
def test_environment_wsl_stub_is_not_reported_as_usable(monkeypatch, state, installed, usable, status):
    """The old `bool(shutil.which("wsl"))` was true on machines without WSL.

    Windows ships wsl.exe as an inbox stub, so presence proves nothing; this is
    what made the first Windows run report wsl2.installed=true while
    `wsl --status` was failing with WSL_E_WSL_OPTIONAL_COMPONENT_REQUIRED.
    """
    from app.services import environment

    monkeypatch.setattr(environment.platform, "system", lambda: "Windows")
    monkeypatch.setattr(environment.platform, "machine", lambda: "AMD64")
    monkeypatch.setattr(environment, "nvidia_devices", lambda: [])
    monkeypatch.setattr(environment, "run", lambda args: "")
    monkeypatch.setattr(environment, "wsl_status", lambda: state)

    got = environment.scan()
    assert got["wsl2"]["installed"] is installed
    assert got["wsl2"]["usable"] is usable
    wsl_check = [c for c in got["checks"] if c["name"] == "WSL2"][0]
    assert wsl_check["status"] == status


def test_wsl_status_treats_a_nonzero_exit_as_not_ready(monkeypatch):
    """`wsl --status` exits 50 when the optional component is missing."""
    from app.services import environment

    monkeypatch.setattr(environment.shutil, "which", lambda name: "C:\\Windows\\System32\\wsl.exe")

    class P:
        returncode = 50

    monkeypatch.setattr(environment.subprocess, "run", lambda *a, **kw: P())
    assert environment.wsl_status() == "present"


def test_wsl_status_is_ready_only_on_exit_zero(monkeypatch):
    from app.services import environment

    monkeypatch.setattr(environment.shutil, "which", lambda name: "C:\\Windows\\System32\\wsl.exe")

    class P:
        returncode = 0

    monkeypatch.setattr(environment.subprocess, "run", lambda *a, **kw: P())
    assert environment.wsl_status() == "ready"


def test_wsl_status_absent_without_the_command(monkeypatch):
    from app.services import environment

    monkeypatch.setattr(environment.shutil, "which", lambda name: None)
    assert environment.wsl_status() == "absent"
