# Docker 部署后端 · 接口契约（冻结）

> 本文是并行开发的**唯一协调点**。任何一方想改这里的字段名、默认值或校验规则，
> 必须先改这份文档，再通知其他方。契约冻结日期见 git log。

## 0. 为什么需要这份文档

Docker 部署要同时落到四个地方（控制面规划、桌面端执行、前端表单、安装引导），
四个地方由不同的人并行写。如果字段名靠猜，最后拼不起来。
所以先把「谁提供什么、什么形状、什么被拒绝」写死。

**信任边界不变**：控制面是提示源，不是命令源。
桌面端**本地**拼 docker argv，控制面返回的 `command` 永远不被执行
（见 `docs/trust-boundary.md`）。

## 1. 后端 id

新增后端 id：`"docker"`。

| 位置 | 改动 |
|---|---|
| `frontend/index.html` `ALL_BACKENDS` | 追加 `"docker"` |
| `desktop/deploy.js` `ALL_BACKENDS` | 追加 `"docker"` |
| `desktop/installers.js` `BACKEND_INFO` | 加 `docker` 一行说明 |
| `backend/app/services/planner.py` | 加 `elif req.backend == "docker":` 分支 |
| `backend/app/services/environment.py` | docker 可用时 `recommended_backends` 里加 `"docker"` |
| `backend/app/services/deployments.py` `start()` | `docker` → `BLOCKED`，理由「容器由桌面端启动，控制面只做规划」 |

控制面**不**执行 docker。这是刻意的：控制面可能在另一台机器上。

## 2. 创建请求

控制面 `DeployRequest`（`backend/app/main.py`）与桌面端 `Deployments.create()`
（`desktop/deploy.js`）接受同一组字段：

```jsonc
{
  "backend": "docker",
  "model_path": "Qwen/Qwen3-8B",       // HF repo id，或容器内路径（配合 volumes）
  "model_id": "qwen3-8b",
  "port": 8000,                         // 宿主端口
  "dtype": "bfloat16",
  "quantization": null,

  // ↓ 仅 backend == "docker" 时有意义
  "image": "vllm/vllm-openai:latest",   // 可选，默认见 §3
  "gpus": "all",                        // "all" | "none" | "0" | "0,1"
  "volumes": [                          // 可选，默认 []
    { "host": "/Users/me/models", "container": "/models", "ro": true }
  ],
  "extra_args": ["--max-model-len", "65536"]   // 可选，默认 []
}
```

非 docker 后端忽略这 4 个字段。字段全部可选，缺省即用默认值。

## 3. 默认值

| 字段 | 默认 | 规则 |
|---|---|---|
| `image` | `vllm/vllm-openai:latest` | 空字符串也当默认 |
| `gpus` | `"all"` | |
| `volumes` | `[]` | |
| `extra_args` | `[]` | |
| `container_port` | 由镜像推断：含 `sglang` → 30000；含 `vllm` → 8000；否则 8080 | 只读，不由请求提供 |

## 4. argv（本地拼装）

桌面端 `_dockerArgv(item, window)` 与控制面 `planner.py` 的预览分支**必须生成同样的形状**：

```
docker run --rm
  -p 127.0.0.1:<port>:<container_port>
  [--gpus <gpus>]                       # gpus == "none" 时整条省略
  -v <host>:<container>[:ro] ...        # 每个 volume 一条
  -e HF_HOME=/hf
  -v <hf_cache>:/hf                     # 始终挂；宿主目录不存在时先创建
  <image>
  <镜像专属参数...>
  <extra_args...>
```

`<镜像专属参数>` 按镜像名子串决定（**不按 backend 决定**，因为镜像是用户给的）。
**两侧都必须先把镜像名转成小写再匹配**（`planner._docker_family` 用 `image.lower()`，
`deploy.js` 用 `.toLowerCase()`）——否则 `VLLM/VLLM-OPENAI:LATEST` 会在控制面得到
8000 + vllm 参数、在桌面端得到 8080 且没有参数，同一个镜像名给出两条不同的命令：

| 镜像含 | 追加 |
|---|---|
| `vllm` | `--model <model_path> --host 0.0.0.0 --port <container_port> --max-model-len <window>` |
| `sglang` | `--model-path <model_path> --host 0.0.0.0 --port <container_port> --context-length <window>` |
| 其它 | 什么都不加，用镜像自带的 CMD |

`<window>` 是控制面 `decision.planned_window` 那**一个整数**，经 `safeWindow()`
夹在 1024~1048576。这是控制面对 argv 的唯一影响。

`hf_cache` = `~/.cache/huggingface`（macOS/Linux）或 `%USERPROFILE%\\.cache\\huggingface`（Windows）。
**注意：不要写成「存在才挂」——必须始终挂。**

`--rm` 意味着容器一停就没了。如果 `HF_HOME=/hf` 指向容器内的 /hf 却没有挂载，
每次 `docker run` 都会把几 GB 的权重重新下一遍——用户看到的是「启动卡住十几分钟」，
而且完全不知道为什么。挂到宿主上，第二次启动才能秒开。

所以：宿主目录不存在时先 `fs.mkdirSync(dir, { recursive: true })` 建出来，再挂。
mkdir 失败只写日志告警，不阻断启动（用户可能挂了自己指定的 HF 目录）。
**用户已经挂了 `/hf` 怎么办**：如果 `volumes` 里已经有 `container === "/hf"` 的条目，
就**跳过**自动挂载，把选择权还给用户（`-e HF_HOME=/hf` 仍然保留）。

不要靠「把自动挂载放到用户 volumes 之前、让用户的靠后覆盖」来解决问题——
那依赖 Docker 的同目标覆盖顺序这个实现细节，而且两条 `-v` 同时出现在命令里本身就会让人困惑。
显式判断更好测。

这条是实测踩出来的：用户在 `-v /tmp/hf:/hf` 之后，app 又追了一条
`-v ~/.cache/huggingface:/hf`，Docker 后挂覆盖先挂，用户显式指定的目录被静默吃掉且没有任何提示。

## 4.1 容器生命周期（`--name` 的代价，必须配套）

**`--name` 只属于桌面端，不在控制面的预览里。** 名字取 `mdp-<部署 id>`：
`deploy.js` 每次启动前要 `docker rm -f mdp-<部署 id>`，所以名字必须由**部署 id** 决定；
而部署 id 在预览时还不存在，控制面也从不执行容器。因此预览里**不出现 `--name`**——
让预览编一个 `mdp-<model_id>` 那样的名字，等于给出一个桌面端永远不会用的名字，
那不是预览，是误导。用户若手工复制预览命令，Docker 会自动命名，不影响使用。

用 `--name mdp-<id>` 是为了能可靠地找到并杀掉容器，但它带来一个坑：
`docker run` 前台跑的时候，如果 Electron 被强杀，**docker CLI 死了但容器还活着**，
名字被占着。下一次启动同一个 id 会直接报 name 冲突。

所以三处都要处理：

| 时机 | 动作 |
|---|---|
| 启动前 | 先 `docker rm -f mdp-<id>`，**忽略失败**（容器不存在是正常的），再 `docker run` |
| 停止时 | 先按现有 `_kill` 给 `docker run` 进程 SIGTERM→宽限→SIGKILL，**然后再** `docker rm -f mdp-<id>` 兜底 |
| 删除部署时 | 同样 `docker rm -f mdp-<id>` |

只杀 CLI 不删容器，会留下一个占着宿主端口的僵尸容器，
而 app 这边显示「已停止」——正是 DESK-03 / DESK-04 那一类「状态和现实不一致」。

`docker rm -f` 这两处都用 `execFile`（argv 数组，不过 shell），超时 15s，失败只写日志不抛错。

## 5. 校验（硬性）

在**两个**入口都做（控制面 Pydantic/服务层 + 桌面端 `create()`）。
不合法 → 控制面 400，桌面端 400，**绝不**拼进 argv。

| 字段 | 规则 |
|---|---|
| `image` | `^[A-Za-z0-9][A-Za-z0-9._/:@-]{0,199}$`；不允许空白、引号、分号、`$`、反引号、`\`、`&`、`|`、`>`、`<` |
| `gpus` | `all` 或 `none` 或 `^[0-9]+(,[0-9]+)*$`（单个数字或逗号分隔） |
| `volumes[].host` | 绝对路径，`^/[^:\u0000]{0,400}$`；桌面端还要求 `fs.existsSync` |
| `volumes[].container` | 绝对路径，`^/[^:\u0000]{0,400}$` |
| `volumes[].ro` | 布尔，缺省 false |
| `volumes` 长度 | ≤ 8 |
| `extra_args` | 字符串数组，≤ 32 项，每项 ≤ 200 字符，不含 NUL 与换行 |
| `port` | 1024 ~ 65535（控制面已有；桌面端 `safePort`） |

非法值一律**拒绝**，不做「清洗后继续」。理由：静默改写用户的镜像名或路径，
比直接报错更糟。

## 6. 诚实规则：macOS 上的容器没有 GPU

- `darwin` 上 docker 部署**允许**（CPU 镜像如 llama.cpp 是能用的），
  但桌面端启动时必须往日志写一条 WARNING，前端必须显示 `gpuPath()` 那段话。
- 不允许把 macOS 上的 docker 部署标成「能用 GPU」。
- `docker` 是否**可部署**只看 `_caps().docker`（Docker 守护进程活着）。
  没装 Docker → 走 `installable`，弹框给安装步骤。

## 7. installers.js 的 docker 安装计划

| 平台 | 计划 |
|---|---|
| darwin + brew | `brew install --cask docker` |
| win32 + winget | `winget install --id Docker.DockerDesktop -e --accept-source-agreements` |
| linux | `cannot()`，manual 指向官方安装文档，理由「需要 root，且各发行版命令不同，不能替你猜」 |
| 无包管理器 | `cannot()`，manual 指向官方安装文档 |

linux 不给一键命令是**故意的**：装 Docker Engine 要 root，
`curl https://get.docker.com \| sh` 是管道执行，违反「argv 数组、不过 shell」。

## 8. 前端表单

`#d-backend` 选中 `docker` 时显示一个 `#d-docker` 区块（其余后端隐藏）：

| 控件 | 类型 | 默认 |
|---|---|---|
| `#d-image` | text | `vllm/vllm-openai:latest` |
| `#d-gpus` | select：`all` / `none` / `0` / `0,1` | `all` |
| `#d-volumes` | textarea，每行 `host:container[:ro]` | 空 |
| `#d-extra` | textarea，**每行一个参数** | 空 |

`#d-extra` 用「每行一个参数」而不是空格分隔，这样带空格的路径不会裂开。

`createDeploy()` 在 `backend === "docker"` 时把这几项塞进请求体；
非 docker 后端不塞。

## 9. 健康检查

`http://127.0.0.1:<port>/health`。vLLM / SGLang 都提供。
若 404，回退 `http://127.0.0.1:<port>/v1/models`。
（回退逻辑只加在桌面端 `_waitHealthy`，控制面 `health()` 保持 `/health`。）

## 10. 测试文件名（冻结，package.json 会引用）

| 文件 | 归属 | 内容 |
|---|---|---|
| `desktop/test-docker.js` | 桌面端执行方 | `_dockerArgv` 形状、校验拒绝、假 docker 二进制跑 `_runDocker` |
| `desktop/test-server.js` | 桌面端基建方 | 代理头透传、上游超时、404 语义、body 上限 |
| `desktop/test-frontend.js` | 前端方 | 用真 Electron 加载 index.html，断言 Docker 区块显隐与请求体 |

假 docker 二进制的做法参考 `desktop/test-mlx.js` 的假 python3：
写一个可执行脚本，忽略参数、起一个真的 `/health` HTTP 服务、保持存活。

## 11. 明确不做

- 控制面不执行 docker（见 §1）。
- 不做 `docker build`、不做 compose、不做 k8s。
- 不做镜像拉取进度 UI（`docker run` 自己会拉，日志里能看到）。
- 不在 macOS 上假装有 GPU。
