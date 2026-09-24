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

// nvidia-smi is not guaranteed to be on PATH: some driver installs only drop it
// in System32, older ones in the NVSMI directory. Try the real locations before
// giving up and falling back to the registry.
function nvidiaSmiCandidates() {
  const list = ["nvidia-smi"];
  if (process.platform === "win32") {
    const winRoot = process.env.SystemRoot || "C:" + BS + "Windows";
    const programFiles = process.env.ProgramFiles || "C:" + BS + "Program Files";
    list.push(winRoot + BS + "System32" + BS + "nvidia-smi.exe");
    list.push(programFiles + BS + "NVIDIA Corporation" + BS + "NVSMI" + BS + "nvidia-smi.exe");
  }
  return list;
}

function runResult(cmd, args) {
  return new Promise((resolve) => {
    try {
      execFile(cmd, args, { timeout: 8000, maxBuffer: 4 << 20 }, (err, stdout) => {
        resolve({ ok: !err, stdout: err ? "" : String(stdout).trim() });
      });
    } catch (e) {
      resolve({ ok: false, stdout: "" });
    }
  });
}

function run(cmd, args) {
  return runResult(cmd, args).then((r) => r.stdout);
}

function gb(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n <= 0) return null;
  const v = Math.round((n / 1024 ** 3) * 10) / 10;
  // A positive amount must not round down to 0: callers use 0/falsy to mean
  // "no data", so a 1-byte report would otherwise look like an absent value.
  return v > 0 ? v : 0.1;
}

function powershell(script) {
  return run("powershell", ["-NoProfile", "-NonInteractive", "-Command", script]);
}

// Windows reports names like "AMD Radeon(TM) Graphics" and "Intel(R) Arc(TM)
// A770 Graphics". Strip the trademark abbreviations and collapse whitespace
// before matching, or "radeon ... graphics" never lines up. Digits are kept:
// "Arc A770" must still read as a discrete Arc card after normalization.
function normalizeGpuName(name) {
  return String(name || "")
    .replace(/\((?:tm|r|c)\)/gi, " ")
    .replace(/[\u2122\u00ae\u00a9]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Names arrive from nvidia-smi, system_profiler and the Windows registry. The
// vendor comes from the name or a driver-provided hint and is normalized so the
// backend and the UI agree on one spelling.
function classifyGpuVendor(name, hint) {
  const s = normalizeGpuName(String(hint || "") + " " + String(name || ""));
  if (/apple/i.test(s) || /\bm[1-9]\b/i.test(s)) return "apple";
  if (/nvidia|geforce|rtx|gtx|quadro|tesla/i.test(s)) return "nvidia";
  if (/amd|radeon|ati\b/i.test(s)) return "amd";
  if (/intel|iris|uhd|arc graphics|hd graphics/i.test(s)) return "intel";
  if (/qualcomm|adreno|snapdragon/i.test(s)) return "qualcomm";
  return "unknown";
}

// Integrated GPUs share system memory; their registry qwMemorySize is a small
// carve-out (often 128MB or 0), so treating it as dedicated VRAM understates the
// machine badly. Discrete add-in and mobile dGPUs are matched first so that e.g.
// "Radeon RX 7600" is not mistaken for an APU's "Radeon Graphics".
function windowsGpuIsUma(name) {
  const s = normalizeGpuName(name).toLowerCase();
  // Discrete add-in and mobile cards. The Arc pattern deliberately omits a
  // trailing \b so the mobile "A770M" is caught too.
  if (/nvidia|geforce|rtx|gtx|quadro|tesla/.test(s)) return false;
  if (/radeon\s+(rx|pro|vii)\b/.test(s)) return false;
  if (/\b(rx|xt)\s?\d{3,4}\b/.test(s)) return false;
  if (/\barc\s+[ab]\d{3}/.test(s)) return false;
  // Shared-memory graphics: APU Radeon, Intel HD/UHD/Iris/Arc Graphics, Adreno.
  // AMD's current laptop iGPUs are three digits + M (780M / 760M / 680M / 890M);
  // the pattern is checked after the discrete rules, and a four-digit model
  // (RX 7600M) has no word boundary before its trailing "M", so it cannot hit.
  if (/\b\d{3}m\b/.test(s)) return true;
  // "Radeon" and "Graphics" may have a model word between them (Vega 8).
  if (/\bradeon[^a-z]*graphics\b/.test(s)) return true;
  if (/intel|iris|uhd graphics|hd graphics|vega\s?\d|adreno|qualcomm|snapdragon/.test(s)) {
    return true;
  }
  return false;
}

// Pure parser so the nvidia-smi line format can be tested without the binary.
function parseNvidiaSmi(out) {
  const gpus = [];
  for (const line of String(out || "").split(/\r?\n/)) {
    const parts = line.split(",").map((s) => s.trim());
    if (parts.length >= 2 && parts[0]) {
      const total = Number(parts[1]);
      gpus.push({
        name: parts[0],
        vendor: classifyGpuVendor(parts[0], "nvidia"),
        vram_gb: Number.isFinite(total) ? Math.round((total / 1024) * 10) / 10 : null,
        uma: false,
      });
    }
  }
  return gpus;
}

async function nvidiaSmi() {
  let out = "";
  for (const candidate of nvidiaSmiCandidates()) {
    const r = await runResult(candidate, [
      "--query-gpu=name,memory.total",
      "--format=csv,noheader,nounits",
    ]);
    if (r.ok && r.stdout) {
      out = r.stdout;
      break;
    }
  }
  return parseNvidiaSmi(out);
}

function parseVmStatPageSize(out) {
  const m = String(out || "").match(/page size of (\d+) bytes/);
  return m ? Number(m[1]) : null;
}

// sysctl is the truth; vm_stat's own header is the next best signal; only then
// fall back to the Intel-era 4K default. Never assume Apple Silicon's 16K: on an
// Intel Mac that would overestimate memory 4x.
function choosePageSize(sysctlValue, vmStatOut) {
  const n = Number(sysctlValue);
  if (Number.isFinite(n) && n > 0) return n;
  const fromVmStat = parseVmStatPageSize(vmStatOut);
  if (fromVmStat) return fromVmStat;
  return 4096;
}

async function darwinPageSize(vmStatOut) {
  return choosePageSize(await run("sysctl", ["-n", "hw.pagesize"]), vmStatOut);
}

// Some macOS builds localize the count with thousands separators
// ("1,234,567."); parseInt would stop at the comma. Stripping them is harmless
// on the un-separated output a normal macOS produces (verified on this M5).
function parseVmStatValue(raw) {
  return parseInt(String(raw).replace(/,/g, ""), 10);
}

// Pure parser: free + inactive + speculative is the conservative reclaimable
// set. Purgeable is deliberately not added (it can overlap inactive) and
// compressor pages are physically occupied, so neither belongs here.
function sumVmStatPages(out) {
  const want = { "Pages free": 1, "Pages inactive": 1, "Pages speculative": 1 };
  let pages = 0;
  for (const line of String(out || "").split(/\r?\n/)) {
    const idx = line.indexOf(":");
    if (idx < 0) continue;
    const key = line.slice(0, idx).replace(/"/g, "").trim();
    const value = parseVmStatValue(line.slice(idx + 1));
    if (Number.isFinite(value) && want[key]) pages += value;
  }
  return pages;
}

async function darwinAvailable() {
  const out = await run("vm_stat", []);
  const pageSize = await darwinPageSize(out);
  const pages = sumVmStatPages(out);
  return pages > 0 ? gb(pages * pageSize) : null;
}

async function probeDarwin(out) {
  out.ram_gb = gb(await run("sysctl", ["-n", "hw.memsize"]));
  out.ram_available_gb = await darwinAvailable();
  out.cpu = (await run("sysctl", ["-n", "machdep.cpu.brand_string"])) || null;
  out.model = (await run("sysctl", ["-n", "hw.model"])) || null;

  let name = out.cpu || out.model || "Apple GPU";
  let hint = "";
  try {
    const parsed = JSON.parse(await run("system_profiler", ["SPDisplaysDataType", "-json"]));
    const first = (parsed.SPDisplaysDataType || [])[0];
    if (first) {
      name = first.sppci_model || first._name || name;
      // The vendor string is more reliable than the model name; use it when the
      // driver provides one, and fall back to name matching otherwise.
      hint = first.spdisplays_vendor || first.sppci_vendor || "";
    }
  } catch (e) {
    // system_profiler is not always JSON; the CPU brand is a fine fallback.
  }
  out.gpus.push({
    name,
    vendor: classifyGpuVendor(name, hint),
    vram_gb: null,
    uma: true,
  });
}

// Pure parser for the "DriverDesc|qwMemorySize" lines the registry script
// prints, so the Windows UMA/vendor logic can be tested without a Windows box.
function parseWindowsRegistryGpus(out) {
  const gpus = [];
  const lines = String(out || "")
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
  for (const line of lines) {
    const [name, vram] = line.split("|");
    if (!name) continue;
    const uma = windowsGpuIsUma(name);
    gpus.push({
      name: name.trim(),
      vendor: classifyGpuVendor(name),
      // A shared-memory GPU has no meaningful dedicated size, so leave it null
      // and let the backend budget from system RAM instead of the 128MB carve-out.
      vram_gb: uma ? null : gb(vram),
      uma,
    });
  }
  return gpus;
}

async function probeWindows(out) {
  const smi = await nvidiaSmi();
  if (smi.length) out.gpus.push(...smi);

  out.ram_gb = gb(await powershell("(Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory"));
  out.ram_available_gb = gb(
    Number(await powershell("(Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory")) * 1024
  );
  // Win32_Processor.Name is one line per physical socket. Taking the first line
  // silently hid the second CPU on a dual-socket box, so join the distinct names.
  out.cpu = (await powershell(
    "$n=@(Get-CimInstance Win32_Processor | Select-Object -ExpandProperty Name | " +
    "Where-Object { $_ } | Select-Object -Unique); [string]::Join(' + ', $n)"
  )) || null;

  if (smi.length) return;

  // Win32_VideoController.AdapterRAM is a uint32 and silently truncates above
  // 4GB, which is why 12GB cards report 4GB. Read the driver REG_QWORD instead.
  const script =
    "Get-ItemProperty '" + REG_GPU_CLASS + BS + "*' -ErrorAction SilentlyContinue | " +
    "Select-Object DriverDesc, @{n='v';e={$_.'HardwareInformation.qwMemorySize'}} | " +
    "ForEach-Object { $_.DriverDesc + '|' + $_.v }";
  out.gpus.push(...parseWindowsRegistryGpus(await powershell(script)));
}

// "Am I inside WSL?" is different from "is the wsl command installed?".
// /proc/version carries a Microsoft marker only in the WSL guest, and there
// /proc/meminfo reports the WSL memory cap rather than the host's RAM.
function detectWsl() {
  try {
    return /microsoft|wsl/i.test(fs.readFileSync("/proc/version", "utf8"));
  } catch (e) {
    return false;
  }
}

async function probeLinux(out) {
  out.gpus.push(...(await nvidiaSmi()));
  out.wsl = detectWsl();
  if (out.wsl) {
    out.wsl_note = "运行在 WSL2 内：/proc/meminfo 是 WSL 的内存限额，可能低于宿主机物理内存";
  }
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
    wsl: false,
  };
  if (process.platform === "darwin") await probeDarwin(out);
  else if (process.platform === "win32") await probeWindows(out);
  else await probeLinux(out);
  out.backends = await detectBackends();
  return out;
}

module.exports = {
  probe,
  run,
  gb,
  normalizeGpuName,
  classifyGpuVendor,
  windowsGpuIsUma,
  parseNvidiaSmi,
  parseWindowsRegistryGpus,
  parseVmStatValue,
  sumVmStatPages,
  parseVmStatPageSize,
  choosePageSize,
  detectWsl,
};
