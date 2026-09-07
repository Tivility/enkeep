# enkeep

中文 | [English](./README-en.md)

基于 [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness) 构建的多用户、多入口企业级平台。

---

## 1. 产品范围与架构概览

Enkeep 为 DeepSeek Harness (DSH) 提供隔离的多租户执行平台。它允许各个租户（**Alice Admin** 和 **Bob User**）在专用的非 root、零网络 Docker 沙箱内执行 Agent 工作流，同时由中央 Platform Server 统一协调会话路由、身份认证与状态管理。

```
+---------------------------------------------------------------------------------------------------+
|                                          Enkeep 平台架构                                          |
|                                                                                                   |
|   +--------------------------+                      +-----------------------------------------+   |
|   |   Platform Server HTTP   |                      |         用户运行时 Docker 容器          |   |
|   |  (127.0.0.1:<dynPort>)   |                      |                                         |   |
|   |  • REST JSON Web API     |  Docker Exec (JSON)  |   Alice 运行时 (Admin)                  |   |
|   |  • Session Cookie Auth   | -------------------> |   • Container: enkeep-demo-alice[-<sfx>]|   |
|   |    (Strict SameSite)     |   (--network none)   |   • Volume:    enkeep-demo-dsh-alice    |   |
|   |  • Host: 127.0.0.1:<port>|                      |                [-<sfx>]                 |   |
|   |  • Origin: http://...    |                      |   • User:      1000:1000 (non-root)     |   |
|   |  • Remote: 127.0.0.1     |                      |   • Volume-ID: enkeep.volume-id         |   |
|   |  • Cursor Event Polling  |                      |   • Transport: docker-exec://           |   |
|   |  • SQLite Storage (v1-v8)|                      +-----------------------------------------+   |
|   +--------------------------+                      |   Bob 运行时 (普通用户)                 |   |
|                 |                                   |   • Container: enkeep-demo-bob[-<sfx>]  |   |
|                 |                                   |   • Volume:    enkeep-demo-dsh-bob      |   |
|   +--------------------------+                      |                [-<sfx>]                 |   |
|   |      本地边界与状态      |                      |   • User:      1000:1000 (non-root)     |   |
|   |   <repoRoot>/.demo-data/ |                      |   • Volume-ID: enkeep.volume-id         |   |
|   |   ├── secrets.json       |                      +-----------------------------------------+   |
|   |   ├── platform.db        |                                                                    |
|   |   ├── pids/*.json        |     [签名元数据]     • HMAC-SHA256 (metaSecret)                    |
|   |   ├── containers/*.json  |                      • Exact enkeep.run-id & enkeep.volume-id      |
|   |   ├── volumes/*.json     |                      • Real Full 64-char Docker CIDs               |
|   |   └── import/            |                      • Zero Network Egress/Ingress                 |
|   |  (Docker 状态保存在卷中) |                      • DSH: $DSH_HOME/sessions/<pKey>/<seg>/...    |
|   +--------------------------+                                                                    |
+---------------------------------------------------------------------------------------------------+
       |                                                                            |
  [零干扰 (Zero Disruption)]                                               [严格安全防线]
  受保护: 127.0.0.1:3000 (HappyClaw)                                       • 禁止 0.0.0.0 / 外部 IM
  受保护: 127.0.0.1:3080 (DSH GUI)                                         • 禁止 docker system/volume prune
  监听器 PID 与 TCP 探测保持不变                                           • 绝不触碰 ~/happyclaw/data
                                                                           • Docker 不可用时故障闭合 (Fail-closed)
```

---

## 2. 文档目录

- **Safety Guardrails & Preflight**: [`docs/safety.md`](docs/safety.md) — 宿主机环回绑定 (`127.0.0.1:<socket.localPort>`)、端口保护 (3000/3080)、本地数据隔离包含以及加密所有权模型 (`volumeName,userId,volumeId`)。
- **Demo Runner Subsystem & CLI**: [`docs/demo.md`](docs/demo.md) — 生命周期编排 (`demo:reset`、`demo:up`、`demo:down`、`demo:test`、`demo:status`)、Docker 容器管理 (`enkeep-demo-alice[-<suffix>]`)、`--remove-vols` 清理销毁以及自动化测试执行。
- **Runtime Architecture & Transport**: [`docs/runtime.md`](docs/runtime.md) — DSH Agent 循环、类型化 Cordis Bundle 组合 (`createEnkeepRuntimeBundle` + `applyEnkeepBundle`)、零网络 Docker 执行 (`DockerExecTransport`)、完整取消机制以及嵌套持久化路径 (`$DSH_HOME/sessions/<project-key>/<encoded-session-id>/session.jsonl`)。
- **Management Console Architecture & Specifications**: [`docs/management-console.md`](docs/management-console.md) — 多租户管理控制台的产品与技术设计（P0 已实现：管理员仪表盘、users/spaces/runtime/plugins/tasks/deliveries/quotas/audit/imports/security 端点与租户自助服务中心；P1/P2 规划中：Agent Prompt Profile 工作台、文件管理器、工具审批卡片与调度器）。

---

## 3. 快速开始

### 3.1 前置要求

- **Node.js**: `^22.19.0 || >=24.0.0`
- **pnpm**: `^10.0.0 || ^11.7.0`
- **Docker Engine / Docker Desktop**: 本地运行中（容器化用户运行时和 Docker 验收测试所必需）

### 3.2 分步执行命令

1. **Install Monorepo Dependencies**:
   ```bash
   pnpm install
   ```

2. **Verify Codebase & Safety Guardrails**:
   ```bash
   pnpm run verify
   ```
   *运行预检安全断言、Monorepo 类型检查、构建、根安全测试以及各 package 测试套件。*

3. **Initialize Demo Environment & Safe Fixtures**:
   ```bash
   pnpm run demo:reset
   ```
   *创建 `<repoRoot>/.demo-data/`，应用 SQLite 数据库迁移 (v1–v8)，预置默认测试账号 (`alice`、`bob`、`charlie_disabled`)，在 `.demo-data/secrets.json` (`0o600`) 中生成安全随机加密密钥，并从 `packages/import-happyclaw/fixtures/source/db/messages.db` 执行事务性测试夹具导入（精确不变量：2 个聊天会话、52 条源消息、50 条导入的人类对话、2 条丢弃的空消息、5 个附件）。*

4. **Start Demo Platform & Container Runtimes (Foreground)**:
   ```bash
   pnpm run demo:up
   ```
   *在动态端口 `127.0.0.1:0` 上启动 Platform HTTP Server，并为 Alice (`enkeep-demo-alice[-<suffix>]`) 和 Bob (`enkeep-demo-bob[-<suffix>]`) 初始化隔离的 Docker 容器。在前台运行并输出活跃端点与动态 URL。*

5. **Inspect Demo Runtime Status**:
   ```bash
   pnpm run demo:status
   # 或输出机器可读的 JSON：
   pnpm run demo:status -- --json
   ```

6. **Run Automated Demo Test Suite**:
   ```bash
   pnpm run demo:test
   ```
   *构建运行时镜像 (`docker:build-runtime`)，并在受保护端口 3000 和 3080 上执行前后监听器 PID 与 TCP 可达性探测，完成完整的验证套件。*

7. **Safely Stop Demo Services**:
   ```bash
   # 保留用户持久化 Docker Volume 以供后续会话恢复
   pnpm run demo:down

   # 或彻底清理进程、容器以及持久化 Docker Volume：
   pnpm run demo:down -- --remove-vols
   ```

### 3.3 凭据与密钥管理

- **Secrets Storage**：运行 `demo:reset` 时，系统使用加密安全随机字节生成加密密钥（`metaSecret`、`cookieSecret`、`csrfToken`），并以受限文件权限 (`0o600`) 保存至 `<repoRoot>/.demo-data/secrets.json`。
- **Zero Log Leakage**：加密密钥与身份认证令牌**绝不输出到 stdout/stderr**，也不会在未认证的 API 响应中返回。
- **Test Accounts**：为离线开发初始化预置测试用户账号（`alice` 为管理员，`bob` 为普通用户），密码均经 Scrypt 哈希加密。预置禁用测试账号 (`charlie_disabled`) 用于验证未授权拒绝行为。严禁使用生产凭证、外部 IM 令牌以及在线/任意导入端点。

---

## 4. 核心技术与安全不变量

### 4.1 DSH 官方唯一会话与运行时真实来源
- 运行在用户容器内的原生 DeepSeek Harness 运行时技术栈（`SessionStore`、`SessionPersistenceJsonl`、`AgentLoop`、`AgentRegistry`）是 Agent 执行与会话持久化的**唯一真实来源 (sole source of truth)**。
- 会话事件持久化至项目嵌套路径：`$DSH_HOME/sessions/<project-key>/<encoded-session-id>/session.jsonl`。若磁盘上已存在会话，则通过 `agents.resume` 恢复。若恢复失败，将抛出 `PersistedSessionResumeError`，而绝不会静默创建一个同名的空会话。

### 4.2 固定离线 HappyClaw 导入器（绝非生产数据）
- 历史数据导入严格离线运行，来源于 `packages/import-happyclaw/fixtures/source/db/messages.db` 的确定性仓库测试夹具。
- **精确夹具不变量**：该夹具严格包含 2 个聊天会话、52 条源消息、50 条导入的人类对话消息、2 条丢弃的空消息以及 5 个附件。
- **严格隔离**：生产环境路径（`$HOME/happyclaw/data`、实际 `$DSH_HOME`、`~/.dsh`、`/etc`）均被路径校验预检防线所拦截。禁止使用动态/任意在线导入 API 端点及外部 IM 令牌。

### 4.3 原子 Cordis 插件：类型化组合与声明式 YAML
- **Composable & Disposable Plugins**：DeepSeek Harness 与 Cordis 插件是独立可组合、可销毁、可升级的 Fiber。
- **Runtime Composition Truth**：运行时容器在 TypeScript 中通过 `@enkeep/dsh-enkeep-bundle` 导出的 `createEnkeepRuntimeBundle({ dshHome, userId, spacesDir })` 与 `applyEnkeepBundle(ctx, bundleEntries)` 组合并应用插件 Fiber。若挂载期间任一插件加载失败，之前加载的 Fiber 将按相反顺序被销毁处置。
- **Declarative YAML Role**：运行时在执行期间绝不读取或解析 YAML 文件。`cordis.patch.yml` 仅作为打包清单声明 (`dsh.bundle.patch`)，用于打包与静态审计。
- **Plugin Conventions**：所有 `@enkeep/dsh-*` 插件均将 `cordis` 和 `dsh` 声明为 `peerDependencies`（绝非运行时依赖），并通过 `ctx.get(name)` 动态访问可选服务。
- 插件包括：
  - `@enkeep/dsh-receipt-store-sqlite`：用于投递幂等性的 SQLite 回执存储。
  - `@enkeep/dsh-inbound`：分发轮次动作 (`followup`、`cancel`) 的入站网关。
  - `@enkeep/dsh-event-relay`：传递实时 Agent 生命周期与消息事件的事件总线。
  - `@enkeep/dsh-tools`：具备严格工作区隔离的出站平台工具 (`send_message`、文件操作)。
  - `@enkeep/dsh-external-interaction`：处理外部审批与提问挂起。
  - `@enkeep/dsh-affinity-policy`：管理会话亲和性与路由边界。
  - `@tivility/dsh-llm-affinity`：附加模型亲和性的路由元数据。

### 4.4 离线确定性适配器边界
- 容器挂载为提供商 `demo-provider` 和模型 `demo-model` 注册的 `DeterministicDemoLlmAdapter`。
- 生成以前缀 `[DemoModel:<user>] ...` 开头的确定性格式化响应，完全离线运行，无需外网访问或远程 API 密钥。

### 4.5 SQLite 数据库迁移 (v1–v8)、事务与崩溃恢复
- 平台存储与服务器迁移 (**v1–v8**) 在 `_schema_migrations` 中跟踪，具备 SHA-256 校验和验证并拒绝降级：
  - v1–v4：核心平台 Schema（用户、凭证、空间、会话路由、配额、审计日志、初始投递收件箱）。
  - v5：带有会话索引的 `web_messages` 与 `web_events` 表。
  - v6：`delivery_inbox` 轮次关联与 `idempotency_records` 表（`held`、`processing`、`completed`、`failed`）。
  - v7：`delivery_inbox` 状态扩展（`held`、`processing`、`delivered`、`duplicate`、`cancelled`、`failed`）。
  - v8：`fixed_import_receipts` 与 `fixed_import_provenance` 表。
- 测试夹具导入在原子 SQLite 事务中执行，填充空间、会话路由、Web 消息与事件游标。
- **Startup Crash Recovery**：
  - **Platform Server / Delivery Gateway 启动**：当 `PlatformServer.start()` 配合可排空的 `DeliveryRuntimeGateway` 启动时，它会执行 `runtimeGateway.redriveHeld()`，进而调用 `recoverDanglingDeliveriesOnStartup()`。这将原子性地将滞留的 `processing` 投递收件箱记录重置为 `held`，将 `processing` 幂等性记录重置为 `held`，并将 `running` 轮次运行记录重置为 `queued`，随后跨租户重新驱动所有 `held` 状态的投递。
  - **Platform Storage 恢复 (`recoverAfterRestart`)**：在没有可排空网关的独立/回退存储模式下，`storage.recoverAfterRestart()` 将传输中的 `processing` 投递重置为 `held`，并将所有未结束的 `running` 与 `queued` 状态的 `turn_runs` 转变为 `interrupted`。
  - `PlatformServer.start()` 清晰协调这一逻辑：若 `runtimeGateway` 提供了 `redriveHeld()`，则仅调用 `runtimeGateway.redriveHeld()`；否则委托给 `storage.recoverAfterRestart()`。
- **Explicit Cancellation & Turn Control**：
  - 轮次取消：`POST /api/turns/:turnId/cancel`
  - 会话级取消：`POST /api/sessions/:sessionId/turn/cancel-current`（配合 `GET /api/sessions/:sessionId/turn/current` 进行轮次状态检查）
  - 取消操作会下发带有跨 exec `SIGUSR1` 信号的 `agent.cancel({ kind: 'user' })`。只有当收到带有 `reason.kind === 'aborted'` 的权威会话 `turn/end` 事件时才视为取消成功，原子性地将轮次运行转为 `interrupted`，将投递收件箱记录转为 `cancelled`，并将幂等性记录转为 `failed`。

### 4.6 零网络工具 Schema 与插件契约
- **Isolated Sandbox**：用户容器在严格的 `--network none` 下运行，无开放网络端口，且对宿主机无 Unix Domain Socket (UDS) 连接。
- **Tool Schemas (4 Schemas)**：`@enkeep/dsh-tools` 插件向 DSH `ToolsRegistry` 注册 4 个工具 Schema（`send_message`、`send_file`、`create_task`、`check_quota`）（`schemasRegistered === true`、`toolsCount === 4`、`plugins.tools === true`）。
- **Platform Client Unavailable**：由于零网络沙箱内未挂载 Platform Client，平台工具执行被禁用（`toolsOperational: false`、`toolsUnavailableReason: 'PLATFORM_CLIENT_UNAVAILABLE'`）。
- **Core Bundle Readiness**：6 个核心运行插件（`receiptStore`、`inbound`、`eventRelay`、`externalInteraction`、`affinityPolicy`、`llmAffinity`）及持久化完全正常运行（`corePluginsReady: true`、`enkeepBundleLoaded: true`）。容器内不发生 UDS 通信或平台工具执行。

### 4.7 平台任务、配额、文件与 Profile 治理
- **Tasks (`agent_prompt`)**：后台任务执行严格遵守 `AgentPromptTaskPayload` 契约：`{ type: 'agent_prompt', prompt: string, sessionId: string, sessionPolicy: 'existing_session', spaceId?: string }`。
- **Resource Quotas (5 Fixed Metrics)**：强制执行 5 项明确的核心指标（`tokens`、`messages`、`turns`、`storage_bytes`、`api_calls`）。未配置的配额策略严格实行 `fail_closed`。配额预留采用原子 CAS 状态转换（`reserved` -> `committed` / `released` / `expired`），并在轮次取消时释放。
- **Files Workbench**：容器 Volume 文件工作台 API (`/api/spaces/:spaceId/files*`)，严格限制在用户容器的 Space Volume 内。
  - 非递归操作：`list`、`read`、`write`、`mkdir`、`rename`、`delete`。
  - 严格先决条件：`mkdir` 要求 `{ requireAbsent: true }`；`write` 要求 `expectedEtag` 或 `requireAbsent: true`；`rename` 要求 `expectedEtag` 且 (`expectedTargetEtag` 或 `requireTargetAbsent: true`)；`delete` 要求 `expectedEtag`。
  - ETag：精确的原生带双引号的小写 SHA-256（`"[0-9a-f]{64}"`）。
- **Agent Profiles Governance**：
  - 4 个组成部分：`IDENTITY`、`SOUL`、`AGENTS`、`TOOLS`。
  - 版本控制：正整数（`1, 2, 3...`），规范 JSON 的 SHA-256 Prompt 哈希。
  - 空间绑定与代际固定 (Generation Pinning)：空间绑定固定活跃版本；会话代际重置在代际边界固定 Profile 快照。
  - 归档行为：软归档将 Profile 状态转换为 `archived`；现有会话保留已固定的快照；已归档的 Profile 无法绑定到新空间。
- **Public ID & Credential Privacy**：公开 REST API 响应中会剔除敏感内部字段（`password_hash`、`token_hash`、`promptHash`、原始 HMAC 密钥、内部数据库 ID、跨租户数据）。`PublicAgentProfileSnapshot` 仅暴露 version、sections、changeSummary 与 createdAt。

### 4.8 架构设计中的有意排除项
- **No Real External IM**：不与外部消息平台（飞书、微信、Telegram、Discord 等）进行在线集成。
- **No Real External Credentials**：不存储或传输生产环境 API 密钥、大模型供应商 Token 或外部凭证。
- **No Arbitrary / Dynamic Imports**：离线数据迁移严格限制在经过验证的仓库测试夹具 (`packages/import-happyclaw/fixtures/source/db/messages.db`)。禁止动态在线导入和外部生产数据库访问。
- **No Host Execution**：用户代码、工具命令和 Agent 轮次均在零网络 Docker 容器内运行，绝不在宿主机上运行。
- **No Arbitrary Host Mounts**：用户容器绝不挂载 `/var/run/docker.sock`、宿主机 `$HOME`、`~/.dsh`、`/etc` 或任意宿主机目录 (`additional_mounts`)。
- **No External MCP / Arbitrary Plugins**：无 Stdio/SSE Model Context Protocol 服务器或未经验证的外部 Cordis 插件。
- **No Host Git / Shell Skills**：无宿主机级别的 Git 自动化或在宿主机执行的 Shell Skill 插件。

### 4.9 Alice 与 Bob 真实 Docker 隔离与加固
- **Containers**：Alice (`enkeep-demo-alice[-<suffix>]`) 与 Bob (`enkeep-demo-bob[-<suffix>]`) 通过精确的 64 位完整容器 ID 进行跟踪。
- **Volumes**：匹配 `^enkeep-demo-dsh-[a-zA-Z0-9][a-zA-Z0-9_-]{0,60}$` 的用户专属 Volume（例如 `enkeep-demo-dsh-alice[-<suffix>]`、`enkeep-demo-dsh-bob[-<suffix>]`）挂载于 `/home/dsh`，且带有独立于 `enkeep.run-id` 的强制不可变 `enkeep.volume-id` 标签。拒绝跨用户共享 Volume。
- **Non-Root Execution**：在 UID/GID `1000:1000` (`dsh`) 下运行，禁止 root 权限执行。
- **Zero-Network Mode**：严格的 `--network none`，零发布网络端口（无 `EXPOSE` 指令）。
- **Transport**：`DockerExecTransport`，通过 `docker exec` (`docker-exec://enkeep-demo-<userId>`) 进行流式 JSON 请求/响应。
- **Hardening & Ownership**：`SafeDockerClient` 拒绝 `docker system prune` 并强制执行多属性所有权检查。Volume 所有权预期要求精确的 `volumeName`、`userId` 和 `volumeId`（无需 `runId`）。
- **Data Location**：容器运行时状态与会话历史持久化保存在专属 Docker Volume 内。宿主机目录 `<repoRoot>/.demo-data/` 仅存放平台元数据、SQLite 数据库及导入产物。

### 4.10 Web 通道、身份认证与 CSRF 防护
- **Host Header Validation**：所有请求在路由前均须经过 Host 请求头验证，严格强制要求精确满足 `Host === 127.0.0.1:<socket.localPort>`，匹配服务器 Socket 的本地端口。
- **CSRF Defense**：状态修改请求 (POST, PUT, PATCH, DELETE) 同时要求恒定时间匹配的 `X-Enkeep-CSRF` 请求头与严格满足 `Origin === http://127.0.0.1:<socket.localPort>`。远端 Socket 地址必须严格精确为 `127.0.0.1`。
- **Session Security**：Scrypt 密码哈希结合签名 Cookie（`cookieSameSite: 'Strict'`）。
- **Content Security Policy (CSP)**：`default-src 'self'; script-src 'self'; style-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'`。
- **Static Assets**：单页应用资源通过 `@enkeep/web-ui` 提供服务，具备严格路径隔离限制，防止任意动态导入。

### 4.11 签名销毁元数据与故障闭合生命周期
- 生成的进程与容器写入由 `secrets.json` 中的 `metaSecret` 作为密钥签名的元数据文件（`.demo-data/pids/`、`.demo-data/containers/`、`.demo-data/volumes/`）。
- 清理销毁 (`demo:down`) 在下发终止命令前，会严格验证 HMAC-SHA256 签名、启动时间、命令行、容器标签以及 Volume 所有权预期 (`volumeName,userId,volumeId`)。
- 若验证失败或 Docker 守护进程不可达，系统将**故障闭合 (fail closed)**，保留元数据并拒绝终止未经验证的资源。

### 4.12 受保护服务免疫（3000 与 3080 端口）
- `127.0.0.1:3000` (HappyClaw) 与 `127.0.0.1:3080` (DeepSeek Harness Web GUI) 上的现有开发服务受到永久保护。
- 在测试执行前后探测监听器 PID（`lsof`/`ps`）和 TCP Socket 连通性（`net.connect`），以断言零干扰。

---

## 5. 严格测试矩阵与验收规则

本仓库强制推行完备的分层测试体系：

| 测试套件 | 命令 | 覆盖范围 |
|---|---|---|
| **安全预检测试** | `pnpm run safety:test` | 宿主机绑定、端口排除 (3000/3080)、`.demo-data` 数据隔离包含、PID 所有权、根脚本构建门禁安全。 |
| **Package 单元与集成测试** | `pnpm run test:packages` | 存储迁移 (v1-v8)、Cordis 插件组合、加密元数据、UDS 客户端、协议编解码器。 |
| **真实 Docker 验收测试** | `pnpm run test:docker` | 构建工作区 (`pnpm run build`)、构建全新 `enkeep-demo-runtime:acceptance` 镜像，并执行全部 3 个强制性 Docker 套件：runtime-runner、demo-runner 和 web-e2e（自动检测 LLM 配置或回退至确定性 Demo 模式，从干净工作树自包含运行）。 |
| **真实 Docker 验收测试（离线 Demo）** | `pnpm run test:docker:demo` | 显式离线 Demo 模式 (`ENKEEP_LLM_ENABLED=0`)，使用确定性模拟适配器执行全部 3 个 Docker 套件。 |
| **完整验证流水线** | `pnpm run verify` | 按序执行 `preflight`、`typecheck`、`build` 以及所有单元/集成测试套件。 |
| **Demo 端到端测试套件** | `pnpm run demo:test` | 从干净工作树运行的自包含完整生命周期测试（构建 packages、构建镜像、执行 reset、认证、导入、隔离、会话、重启恢复、Docker 执行、受保护端口监听器/TCP 探测）。 |

*验收与门禁不变量*：
- **权威根命令**：根命令（`pnpm run test:docker`、`pnpm run demo:test`、`pnpm run verify`、`pnpm test`）是权威入口点，通过拓扑构建门禁 (`pnpm run build`) 保证从干净工作树自包含执行。当调用单独 package 过滤命令时（如 `pnpm --filter @enkeep/demo-runner run test:docker`），调用方应确保工作区 package 已完成构建。
- **验收规则**：验收套件要求所有声明的测试套件均须执行，不得存在隐式跳过。

---

## 6. 工作区结构

本 Monorepo 包含 20 个使用 `pnpm` 管理的工作区 Package：

```
packages/
├── demo-runner/                Demo 生命周期编排器与 CLI (reset, up, down, test, status)
├── dsh-affinity-policy/        DSH Agent 亲和性与会话路由策略 (Cordis 插件)
├── dsh-enkeep-bundle/          DSH Cordis bundle 运行时组合 (createEnkeepRuntimeBundle)
├── dsh-event-relay/            DSH 事件总线与中继 (Cordis 插件)
├── dsh-external-interaction/   DSH 外部交互工具与审批挂起
├── dsh-inbound/                DSH 入站消息网关 (followup/cancel 分发器)
├── dsh-platform-client/        连接 Platform Server 的 UDS 与 HTTP 客户端（具备重试逻辑）
├── dsh-receipt-store-sqlite/   基于 SQLite 持久化的回执存储 (Cordis 插件)
├── dsh-tools/                  出站平台工具 (send_message、工作区文件系统防线)
├── import-happyclaw/           HappyClaw 离线数据库迁移与测试夹具导入器
├── platform-auth/              认证服务，采用 Scrypt 密码哈希与签名 Cookie
├── platform-core/              核心领域类型、错误定义与 Branded ID
├── platform-operations/        平台运营服务、配额与审计日志
├── platform-server/            HTTP API 服务器（REST API、基于游标的事件轮询、路由）
├── platform-storage-sqlite/    SQLite 存储仓储、CAS 状态转换与迁移 (v1-v8)
├── protocol/                   传输协议 Schema、Branded 编码器与 JSON 编解码器
├── runtime-runner/             容器与进程运行时运行器、SafeDockerClient 与 CLI
├── web-channel/                Web 通道、路由 Key 与 CSRF/会话网关
├── web-e2e/                    端到端契约、Playwright UI 与 Docker 测试套件
└── web-ui/                     SPA 前端静态资源与安全资源加载器
```

---

## 7. 故障排查指南

| 现象 | 原因 | 解决方案 |
|---|---|---|
| `SafetyViolationError: UNSAFE_HOST_BINDING` | 服务器或脚本尝试绑定到 `0.0.0.0`、`localhost` 或公网 IP。 | 确保宿主机绑定严格设置为精确的 `127.0.0.1`。 |
| `SafetyViolationError: UNSAFE_PORT_ALLOCATION` | 目标端口为保留端口（`3000` 或 `3080`）。 | 使用临时动态端口 `0` 或指定未保留的端口。 |
| `DockerDaemonUnavailableError` | 宿主机上未运行 Docker 守护进程。 | 启动 Docker Desktop 或 Docker Engine 守护进程。 |
| `PersistedSessionResumeError` | 容器持久化 Volume 中的会话 JSONL 文件损坏。 | 运行 `pnpm run demo:reset` 或 `pnpm run demo:down -- --remove-vols` 重新初始化干净的 Volume 状态。 |
| `CsrfViolationError` (403) | 缺少或无效的 `X-Enkeep-CSRF` 请求头，或 Host/Origin 与 Socket 端口不匹配。 | 通过 `GET /api/auth/csrf` 获取 CSRF Token，并在状态修改请求中附带请求头 `X-Enkeep-CSRF` 及匹配的 `Origin`。 |
| `ActiveProcessesRunningError` 出现于 `demo:reset` | 先前的 Demo 进程仍在运行。 | 在重置 Demo 环境前运行 `pnpm run demo:down`。 |

---

## 8. 约定与依赖策略

- **Cordis / DSH 插件 (`packages/dsh-*`)**：通用 DSH 与 Cordis 插件包遵循插件规范：`dsh` / `cordis` 相关包为 `peerDependencies`（及 dev），绝不能作为运行时依赖项；插件是独立可组合、可销毁、可升级的 Fiber；不得混用插件导出形式；通过 `ctx.get(name)` 读取可选服务。
- **运行时组合**：运行时容器通过 `@enkeep/dsh-enkeep-bundle` 中的 `createEnkeepRuntimeBundle` 与 `applyEnkeepBundle` 组合插件。运行时绝不读取或解析 YAML 文件；`package.json` 中的 package `dsh.bundle.patch` 声明指向 `cordis.patch.yml` 仅用作打包元数据。
- **独立运行时与运行器包 (`runtime-runner`, `demo-runner`)**：独立的宿主机/容器运行时运行器合理地声明显式 DSH 运行时依赖（例如 `@deepseek-ai/dsh-*` 引擎与持久化层），以满足独立服务器、CLI 及容器化运行时执行的必要需求。
