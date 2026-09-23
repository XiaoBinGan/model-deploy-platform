# Windows 支持现状与缺口

> **验证状态说明**：本文所有 Windows 结论均为**静态代码审查**，没有在 Windows 上
> 执行过任何一条。本机是 macOS（Apple M5 / arm64），无法运行 Windows 分支。
> 下面每条都给出了代码位置，便于在真机上复核。

---

## 一、现状：哪些地方写了 Windows

| 位置 | 内容 | 是否执行过 |
|---|---|---|
| desktop/probe.js:98-130 | probeWindows()：注册表 QWORD + CIM | 否 |
| backend/app/services/gpu_table.py | AMD 9 条 / Intel 6 条 | 否（表是数据，无需执行） |
| backend/app/services/environment.py:31 | wsl 检测 | 否 |
| frontend/index.html:145 | pf-platform 下拉含 win32 | 否 |
| frontend/index.html:215 | UA 含 Windows → win32 | 否 |
| desktop/README.md:35 | 文档描述了 Windows 探测 | — |

**没有任何 Windows CI、没有 Windows 测试、没有 Windows 打包配置。**

---

## 二、缺口

### A. 手动探测脚本在 Windows 上完全不可用（P0）

backend/app/services/profiles.py:92-115 的 PROBE_SCRIPT 只有两个分支：

    system = platform.system()
    ram_gb = None

    if system == "Darwin":
        ram_gb = round(int(run(["sysctl", "-n", "hw.memsize"])) / 1024 ** 3, 1)
        ...
    else:
        with open("/proc/meminfo") as fh:      # ← Windows 走这里
            ...

Windows 落到 else 分支，打开 /proc/meminfo（Windows 上不存在）→ OSError 被
静默吞掉 → **ram_gb 恒为 None**。GPU 也只剩 nvidia-smi 一条路。

三个具体问题：

1. **内存恒为 None**：Windows 用户跑这个脚本，永远拿不到内存容量。
2. **平台名对不上**：脚本输出 platform.system().lower() = "windows"，
   但前端 pf-platform 的枚举是 darwin / win32 / linux / unknown
   —— 没有 windows。平台识别静默失败。
3. **给出的命令跑不起来**：profiles.py:132-134

       return "curl -fsSL " + base + "/api/hardware/probe.py | python3 -"

   - Windows 默认没有 python3（是 python 或 py）
   - Windows PowerShell 5.1 里 curl 是 Invoke-WebRequest 的别名，不认 -fsSL
   - 即使 PowerShell 7 有真 curl.exe，管道到 python3 - 也没有对应解释器

docs/probe-session-design.md:142 已经设计了
`GET /api/hardware/probe/{token}.ps1`（内嵌 token 与回调地址的 PowerShell 脚本），
**但从未实现**。

### B. probeWindows() 从未执行过，静态审查出 5 个问题（P1）

desktop/probe.js:98-130。以下都是代码审查结论，需真机复核：

1. **集成显卡被当成独立显卡**（最严重）

       uma: false,     // 硬编码

   Intel Iris Xe、AMD Radeon 集成显卡、Windows ARM 的 Adreno 都共享系统内存，
   但注册表 HardwareInformation.qwMemorySize 对它们通常报 128MB 或 0。
   结果：**内存被严重低估**，推荐出远小于实际能力的模型。
   对比 macOS 分支正确设了 uma: true（probe.js:94）。

2. **vendor 只识别 nvidia**

       vendor: /nvidia|geforce|rtx/i.test(name) ? "nvidia" : "unknown",

   AMD Radeon 和 Intel Arc 全部被标成 unknown。
   好消息：gpu_table.lookup() 不按 vendor 过滤（只做子串匹配），所以查表仍能命中；
   但 ProfileResult 里回传的 vendor 字段是错的，用户看到 unknown。

3. **nvidia-smi 不在 PATH 时没有回退**

   desktop/README.md:38 和 docs/probe-session-design.md:181 都自己指出过
   「nvidia-smi 不一定在 PATH」，但代码只调用了一次 nvidia-smi，
   没有回退到 C:\Windows\System32\nvidia-smi.exe 或驱动目录。

4. **多路 CPU 只取第一行**：Win32_Processor).Name 返回多行时没有处理。

5. **Windows ARM64（Snapdragon X 等）未考虑**：process.platform 仍是 win32，
   没有 nvidia-smi，GPU 是 Adreno（UMA）→ 与问题 1 叠加。

### C. WSL2 未识别，会低估内存（P1）

在 WSL 里运行桌面端时 process.platform === "linux"，走 probeLinux()，
读 /proc/meminfo 得到的是 **WSL 的限额**（默认约为宿主机的一半），
不是宿主机的真实内存。

- desktop/probe.js 全文没有任何 wsl / microsoft 检测
- environment.py:27 的 wsl=bool(shutil.which("wsl")) 检测的是
  「这台机器上有没有 wsl 命令」（即在 Windows 宿主机上），
  **不是「我当前是否运行在 WSL 内部」**，两件事完全不同

后果：WSL 用户拿到的内存偏低 → 推荐过小的模型。

### D. platform 取值不统一，且无人校验（P2）

同一个概念在四个地方取值不同：

| 来源 | 取值 |
|---|---|
| frontend pf-platform 下拉 | darwin / win32 / linux / unknown |
| 浏览器 UA 探测 | darwin / win32 / linux |
| PROBE_SCRIPT 输出 | darwin / **windows** / linux |
| probe.js | process.platform（darwin / win32 / linux） |

hardware.py:227 只是 _clean_text(profile.get("platform"), 32) or "unknown"，
**不做枚举校验**，所以 windows 会被原样接受并静默传播，不会报错。

应该：定义唯一的平台枚举，在 hardware.py 入口归一化（windows → win32）。

### E. 出不了 Windows 安装包（P2）

desktop/package.json 全文：

    "scripts": { "start": "electron ." },
    "devDependencies": { "electron": "^33.0.0" }

**没有 electron-builder / electron-forge，没有任何打包配置。**
目前只能 npm start 起开发态，产不出 .exe / 安装包。

docs/probe-session-design.md:564 提到过 macOS 出 .dmg、Windows 出 nsis、
Linux 出 AppImage，但一行都没实现。

配套还缺：
- 代码签名（Windows 未签名首次运行有 SmartScreen 警告，desktop/README.md:110）
- 企业终端防护可能直接隔离（docs/probe-session-design.md:453）

### F. smoke 断言写死了本机阈值（P3）

desktop/smoke.js:99

    (localPlan.hardware || {}).usable_vram_gb > 10.5

这是按本机 Apple M5（19.2GB 可用）写死的。在显存更小的 Windows 机器上会失败，
与代码正确性无关。应改成相对断言（例如 > 0 且与 /api/hardware/self 一致）。

---

## 三、建议顺序

| 优先级 | 内容 | 说明 |
|---|---|---|
| P0 | PROBE_SCRIPT 加 Windows 分支（CIM 取内存 + 注册表 QWORD 取显存） | 否则 Windows 用户拿不到内存 |
| P0 | probe_command 按平台给不同命令，补 PowerShell 版本 | 现在给的命令 Windows 跑不起来 |
| P1 | 实现设计文档里的 probe.ps1 | 设计已完成，实现缺失 |
| P1 | probeWindows 的 iGPU 判定（uma）+ vendor 识别 | 直接影响推荐正确性 |
| P1 | WSL2 检测（在 probe.js 里读 /proc/version 判 microsoft） | 避免低估内存 |
| P2 | 统一 platform 枚举并在 hardware.py 归一化 | 消除静默的平台识别失败 |
| P2 | 接入 electron-builder，出 nsis 安装包 | 否则无法交付 |
| P3 | smoke 断言改成相对判断 | 让测试能在别的机器上跑 |

---

## 四、一句话总结

Windows 路径是**「按设计写了、从未跑过」**的状态：
probeWindows() 代码在，但 iGPU/vendor 判定有实质错误；
而用户实际会用到的那条路——手动探测脚本和它给出的命令——**在 Windows 上
是直接不可用的**（内存恒为 None，命令语法不对）。
再加上没有打包配置，目前 Windows 用户既测不出硬件，也拿不到安装包。
