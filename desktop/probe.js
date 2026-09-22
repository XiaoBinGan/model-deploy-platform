"use strict";

const { execFile } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");

// Windows keeps the real VRAM size in this class key as a REG_QWORD.
// The path is joined at runtime so this file contains no escape sequences.
const BS = String.fromCharCode(92);
const REG_GPU_CLASS = [
  "HKLM:",
  "SYSTEM",
  "CurrentControlSet",
  "Control",
  "Class",
  "{4d36e968-e325-11ce-bfc1-08002be10318}",
].join(BS);

function run(cmd, args) {
  return new Promise((resolve) => {
    try {
      execFile(cmd, args, { timeout: 8000, maxBuffer: 4 << 20 }, (err, stdout) => {
        resolve(err ? "" : String(stdout).trim());
      });
    } catch (e) {
      resolve("");
    }
  });
}

function gb(bytes) {
  const n = Number(bytes);
  return Number.isFinite(n) && n > 0 ? Math.round((n / 1024 ** 3) * 10) / 10 : null;
}

function powershell(script) {
  return run("powershell", ["-NoProfile", "-NonInteractive", "-Command", script]);
}

async function nvidiaSmi() {
  const out = await run("nvidia-smi", [
    "--query-gpu=name,memory.total",
    "--format=csv,noheader,nounits",
  ]);
  const gpus = [];
  for (const line of out.split(/\r?\n/)) {
    const parts = line.split(",").map((s) => s.trim());
    if (parts.length >= 2 && parts[0]) {
      const total = Number(parts[1]);
      gpus.push({
        name: parts[0],
        vendor: "nvidia",
        vram_gb: Number.isFinite(total) ? Math.round((total / 1024) * 10) / 10 : null,
        uma: false,
      });
    }
  }
  return gpus;
}

async function darwinAvailable() {
  const pageSize = Number(await run("sysctl", ["-n", "hw.pagesize"])) || 16384;
  const out = await run("vm_stat", []);
  const want = { "Pages free": 1, "Pages inactive": 1, "Pages speculative": 1 };
  let pages = 0;
  for (const line of out.split(/\r?\n/)) {
    const idx = line.indexOf(":");
    if (idx < 0) continue;
    const key = line.slice(0, idx).replace(/"/g, "").trim();
    const value = parseInt(line.slice(idx + 1), 10);
    if (Number.isFinite(value) && want[key]) pages += value;
  }
  return pages > 0 ? gb(pages * pageSize) : null;
}

async function probeDarwin(out) {
  out.ram_gb = gb(await run("sysctl", ["-n", "hw.memsize"]));
  out.ram_available_gb = await darwinAvailable();
  out.cpu = (await run("sysctl", ["-n", "machdep.cpu.brand_string"])) || null;
  out.model = (await run("sysctl", ["-n", "hw.model"])) || null;

  let name = out.cpu || out.model || "Apple GPU";
  try {
    const parsed = JSON.parse(await run("system_profiler", ["SPDisplaysDataType", "-json"]));
    const first = (parsed.SPDisplaysDataType || [])[0];
    if (first) name = first.sppci_model || first._name || name;
  } catch (e) {
    // system_profiler is not always JSON; the CPU brand is a fine fallback.
  }
  out.gpus.push({
    name,
    vendor: /apple|m[1-4] /i.test(name) ? "apple" : "unknown",
    vram_gb: null,
    uma: true,
  });
}

async function probeWindows(out) {
  const smi = await nvidiaSmi();
  if (smi.length) out.gpus.push(...smi);

  out.ram_gb = gb(await powershell("(Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory"));
  out.ram_available_gb = gb(
    Number(await powershell("(Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory")) * 1024
  );
  out.cpu = (await powershell("(Get-CimInstance Win32_Processor).Name")) || null;

  if (smi.length) return;

  // Win32_VideoController.AdapterRAM is a uint32 and silently truncates above
  // 4GB, which is why 12GB cards report 4GB. Read the driver REG_QWORD instead.
  const script =
    "Get-ItemProperty '" + REG_GPU_CLASS + BS + "*' -ErrorAction SilentlyContinue | " +
    "Select-Object DriverDesc, @{n='v';e={$_.'HardwareInformation.qwMemorySize'}} | " +
    "ForEach-Object { $_.DriverDesc + '|' + $_.v }";
  const lines = (await powershell(script))
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
  for (const line of lines) {
    const [name, vram] = line.split("|");
    if (!name) continue;
    out.gpus.push({
      name: name.trim(),
      vendor: /nvidia|geforce|rtx/i.test(name) ? "nvidia" : "unknown",
      vram_gb: gb(vram),
      uma: false,
    });
  }
}

async function probeLinux(out) {
  out.gpus.push(...(await nvidiaSmi()));
  try {
    const text = fs.readFileSync("/proc/meminfo", "utf8");
    for (const line of text.split("\n")) {
      if (line.startsWith("MemTotal:")) out.ram_gb = gb(Number(line.split(/\s+/)[1]) * 1024);
      if (line.startsWith("MemAvailable:")) out.ram_available_gb = gb(Number(line.split(/\s+/)[1]) * 1024);
    }
  } catch (e) {
    // /proc is absent in some containers; leave RAM unknown.
  }
}

async function detectBackends() {
  const backends = {};
  try {
    const r = await fetch("http://127.0.0.1:11434/api/tags", { signal: AbortSignal.timeout(1500) });
    const j = r.ok ? await r.json() : null;
    backends.ollama = { installed: !!j, models: j ? (j.models || []).length : 0 };
  } catch (e) {
    backends.ollama = { installed: false, models: 0 };
  }
  return backends;
}

async function probe() {
  const out = {
    source: "agent",
    platform: process.platform,
    architecture: os.arch(),
    cpu_cores: os.cpus().length,
    cpu: null,
    ram_gb: null,
    ram_available_gb: null,
    gpus: [],
    backends: {},
  };
  if (process.platform === "darwin") await probeDarwin(out);
  else if (process.platform === "win32") await probeWindows(out);
  else await probeLinux(out);
  out.backends = await detectBackends();
  return out;
}

module.exports = { probe, run };
