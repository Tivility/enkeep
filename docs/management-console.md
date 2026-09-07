# Enkeep 管理控制台（Management Console）产品与技术设计规范

---

## 1. 对比方法论与安全边界 (Comparison Methodology & Safety Boundary)

### 1.1 设计目标与定位
Enkeep 是基于 [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness) 构建的企业级、多租户、安全隔离的智能体执行与会话管理平台。本技术设计规范旨在基于公开源码调研 HappyClaw 的全量产品功能特性，对齐其管理与管控能力，结合 Enkeep 自身零网络 Docker 沙箱（`--network none`）、非 root 运行（UID/GID `1000:1000`）、DSH 官方 Agent 循环与 Cordis 插件架构，规划并定义 Enkeep 的首个自洽管理控制台增量（Management Console First Coherent Increment）。

### 1.2 源码级对比方法论（Source-Only Comparison）
为了确保调研严谨、结论准确且完全符合工程安全规范，本设计规范严格执行**纯源码静态分析（Source-Only Analysis）**方法论：
1. **对比真相源输入**：
   - HappyClaw 公开代码仓库目录：`happyclaw/web/src/`、`happyclaw/docs/API.md`、`happyclaw/docs/ACL-MATRIX.md`、`happyclaw/CLAUDE.md`。
   - Enkeep 源码仓库全量包：`packages/platform-core/`、`packages/platform-storage-sqlite/`、`packages/platform-operations/`、`packages/platform-server/`、`packages/platform-auth/`、`packages/runtime-runner/`、`packages/dsh-enkeep-bundle/`、`packages/web-channel/`、`packages/web-ui/`、`packages/import-happyclaw/`。
2. **严禁访问生产资产与实时状态**：
   - 严禁读取 HappyClaw 生产环境数据、外部数据库（如 `$HOME/happyclaw/data`、`messages.db`）、生产 `.env` 配置文件、上传文件目录、实时日志、进程内存快照。
   - 严禁向任何正在运行的 HappyClaw 实例或 DSH GUI 发送实时业务 HTTP/WebSocket 流量或侵入性调用。

### 1.3 严格安全隔离边界与零侵入原则
Enkeep 平台与宿主机及周边服务的协同遵循严格的安全边界：
- **数据存储隔离**：宿主机根目录仅使用 `<repoRoot>/.demo-data/` 存放平台元数据、加密秘钥（`secrets.json`，权限 `0o600`）、平台 SQLite 数据库（`platform.db`）及固定导入制品。用户的真实 DSH 运行时持久化文件、项目目录及工具产物严格保存在隔离的 Docker Volume（如 `enkeep-demo-dsh-alice`、`enkeep-demo-dsh-bob`）中，严禁写入宿主机用户主目录（`$HOME`、`$DSH_HOME`、`~/.dsh`）。
- **固定离线测试固件（Fixed Repository Fixtures）**：历史数据导入仅允许读取仓库内固化的测试固件 `packages/import-happyclaw/fixtures/source/db/messages.db`（精确不变量：2 个聊天、52 条源消息、50 条导入有效消息、2 条丢弃的空消息、5 个附件），严禁引入动态/未受控的外部数据源。
- **无外网纯沙箱隔离**：租户 Docker 容器统一使用 `--network none` 启动，无对外暴露端口（Docker 镜像零 `EXPOSE` 指令），平台服务与容器间通过 `DockerExecTransport`（`docker exec -i`）进行结构化 JSON 流传输。

### 1.4 受保护服务免疫原则（Protected Ports 3000 & 3080）
在本地多服务协同开发与演进过程中，以下服务具备永久免疫保护，Enkeep 的任何脚本、测试、管理控制台及运行进程**严禁占用、重启、终止或干扰**：
- **HappyClaw Web/API 服务**：默认监听 `127.0.0.1:3000`。
- **DeepSeek Harness Web GUI 服务**：默认监听 `127.0.0.1:3080`。
- **动态回环绑定机制**：Platform Server 必须采用动态监听端口（Node.js 监听 host `127.0.0.1` 端口 `0`，即由操作系统内核分配动态空闲端口），并强制校验 `Host: 127.0.0.1:<socketPort>`、`Origin` 与回环来源。
- **端口 3000/3080 免疫与安全探针**：测试与安全 Harness 仅对端口 3000（HappyClaw）和 3080（DSH GUI）执行监听者 PID 与 TCP 连通性/身份探针（用于断言未受干扰），绝不发送任何应用层业务流量或写入请求，严禁向其监听进程发送任何中断或终止信号，保证周边既有环境 100% 稳定运行。

---

## 2. HappyClaw 功能清单与源码溯源 (HappyClaw Feature Inventory & Citations)

基于对 HappyClaw 仓库公开前端源码（`happyclaw/web/src/`）与技术文档（`docs/API.md`、`docs/ACL-MATRIX.md`）的系统性梳理，HappyClaw 的核心功能清单与对应精确源文件索引如下：

| 功能模块 | 对应页面/组件文件 (happyclaw/web/src) | 对应后端路由/文档 (happyclaw/docs/API.md) | 核心业务能力描述 |
| :--- | :--- | :--- | :--- |
| **工作台与会话 (Chat / Workspace)** | `pages/ChatPage.tsx`<br>`components/chat/ChatView.tsx`<br>`components/chat/SessionSidebar.tsx`<br>`components/chat/TopicSidebar.tsx`<br>`components/chat/MessageList.tsx`<br>`components/chat/MessageInput.tsx`<br>`components/chat/FilePanel.tsx`<br>`components/chat/FileUploadZone.tsx`<br>`components/chat/TerminalPanel.tsx`<br>`components/chat/TodoProgressPanel.tsx`<br>`components/chat/ToolActivityCard.tsx`<br>`components/chat/WorkflowRunCard.tsx`<br>`components/chat/ContainerEnvPanel.tsx`<br>`components/chat/HostDirectoryMountEditor.tsx`<br>`components/chat/InteractionModeSelector.tsx` | `/api/groups`<br>`/api/workspaces`<br>`/api/messages`<br>`/api/follow-ups`<br>`/ws` | 工作区投影浏览、主会话与多 Runtime Session 切换、飞书/原生话题映射、流式消息与 Markdown/Mermaid 渲染、文件浏览/上传/下载/预览、容器内 Web 终端（xterm.js）、Todo 任务进度面板、工具调用折叠卡片、工作流执行卡片、环境变量配置、管理员宿主机目录挂载配置（`additional_mounts`）。 |
| **Agent 治理 (Agent Profiles)** | `pages/AgentProfilesPage.tsx`<br>`components/agents/AgentPromptEditor.tsx`<br>`components/agents/AgentPromptAssistant.tsx`<br>`components/agents/AgentPromptVersionHistory.tsx`<br>`components/agents/AgentSkillsPolicyEditor.tsx`<br>`components/agents/EffectiveCapabilitiesPreview.tsx`<br>`components/agents/PolicyResourcePicker.tsx`<br>`components/agents/AgentGovernanceSection.tsx` | `/api/agent-profiles`<br>`/api/agent-profiles/:id/refine-prompt`<br>`/api/agent-profiles/:id/prompt-versions`<br>`/api/agent-profiles/:id/effective-capabilities` | 产品级 Agent Profile 创建与管理、四段 Prompt（IDENTITY / SOUL / AGENTS / TOOLS）编辑、版本历史追溯与一键回滚、AI 辅助 Prompt 优化、技能/工具策略绑定、生效能力与上下文预算（PromptPlan / ContextBudget）实时快照对比。 |
| **能力生态 (Capabilities)** | `pages/CapabilitiesPage.tsx`<br>`pages/SkillsPage.tsx`<br>`pages/McpServersPage.tsx`<br>`pages/PluginsPage.tsx`<br>`components/skills/SkillCard.tsx`<br>`components/skills/InstallSkillDialog.tsx`<br>`components/mcp-servers/McpServerCard.tsx`<br>`components/mcp-servers/McpServerDetail.tsx`<br>`components/mcp-servers/AddMcpServerDialog.tsx` | `/api/skills`<br>`/api/mcp-servers`<br>`/api/plugins`<br>`/api/groups/:jid/workspace-config/skills`<br>`/api/groups/:jid/workspace-config/mcp-servers` | 用户级与系统级 Skills 目录、内置与自定义 Skill 安装与卸载、MCP Server（Stdio / SSE）注册与参数配置、插件市场（Plugin Catalog）扫描与启用状态管理、工作区级别独立能力重写与覆盖。 |
| **任务调度 (Tasks / Scheduler)** | `pages/TasksPage.tsx`<br>`components/tasks/TaskCard.tsx`<br>`components/tasks/TaskDetail.tsx`<br>`components/tasks/CreateTaskForm.tsx` | `/api/tasks`<br>`/api/tasks/:id/run`<br>`/api/tasks/:id/history` | 定时任务配置（Cron、Interval、Once 模式）、任务关联工作区与 Agent 绑定、任务执行历史与运行日志查看、手动立即触发、服务重启后错失任务补跑/标记逻辑。 |
| **运行监控 (Monitor / Runtime)** | `pages/MonitorPage.tsx`<br>`components/monitor/SystemInfo.tsx`<br>`components/monitor/QueueStatus.tsx`<br>`components/monitor/ContainerStatus.tsx`<br>`components/monitor/GroupStatusCard.tsx`<br>`components/monitor/ProviderSwitcher.tsx` | `/api/health`<br>`/api/monitor/status`<br>`/api/docker/build`<br>`/api/status/channel-outbox/*` | 系统资源负载与健康检查、会话串行队列与并发控制状态、活动 Docker 容器列表与暖 Runner 存活状态、渠道 Outbox 积压与人工裁决介入、模型 Provider 实时负载监控。 |
| **用量与计费 (Usage & Billing)** | `pages/UsagePage.tsx`<br>`pages/BillingPage.tsx`<br>`components/billing/AdminDashboard.tsx`<br>`components/billing/AdminUsersList.tsx`<br>`components/billing/AdminPlansList.tsx`<br>`components/billing/AdminRedeemCodesList.tsx`<br>`components/billing/AdminBillingSettings.tsx`<br>`components/billing/BalanceCard.tsx`<br>`components/billing/DailyUsageChart.tsx`<br>`components/billing/PricingGrid.tsx`<br>`components/billing/UserBillingDrawer.tsx`<br>`components/usage/UsageTrendChart.tsx` | `/api/usage`<br>`/api/usage/summary`<br>`/api/billing/my/*`<br>`/api/billing/admin/*` | Token 消耗日级趋势与分类报表、模型级用量统计、个人账户余额与订阅计划、管理员计费大盘、套餐计划管理、兑换码生成与核销、多租户账单与扣费事务流水。 |
| **记忆管理 (Memory)** | `pages/MemoryPage.tsx` | `/api/memory`<br>`/api/memory/search` | 基于文件系统的长短期记忆索引、记忆条目全文检索、记忆内容查看与手动修剪。 |
| **系统与渠道设置 (Settings)** | `pages/SettingsPage.tsx`<br>`components/settings/ProfileSection.tsx`<br>`components/settings/SecuritySection.tsx`<br>`components/settings/PreferencesSection.tsx`<br>`components/settings/ChannelAccountsManager.tsx`<br>`components/settings/UserChannelsSection.tsx`<br>`components/settings/BindingsSection.tsx`<br>`components/settings/SystemSettingsSection.tsx`<br>`components/settings/RegistrationSection.tsx`<br>`components/settings/ClaudeProviderSection.tsx`<br>`components/settings/GptProviderSection.tsx`<br>`components/settings/GrokProviderSection.tsx`<br>`components/settings/PairingSection.tsx` | `/api/auth/profile`<br>`/api/auth/password`<br>`/api/auth/sessions`<br>`/api/config`<br>`/api/channel-accounts`<br>`/api/groups/:jid/im-binding` | 个人信息与密码修改、活动登录会话（User Sessions）吊销、多渠道机器人账号（飞书、Telegram、QQ、钉钉、微信、Discord、WhatsApp）凭据与 Webhook 管理、渠道与工作区绑定关系配置、系统模型 Provider 密钥与基础外观设置。 |
| **用户与审计 (Users & Audit)** | `pages/UsersPage.tsx`<br>`components/users/UserListTab.tsx`<br>`components/users/InviteCodesTab.tsx`<br>`components/users/AuditLogTab.tsx` | `/api/admin/users`<br>`/api/admin/invites`<br>`/api/admin/audit-log`<br>`/api/admin/audit-log/export` | 用户全量列表、账户启用/禁用状态切换、角色与权限分配、注册邀请码批量生成与核销追踪、全站安全与认证审计日志（IP/UserAgent/Action/Details）检索与导出。 |

---

## 3. Enkeep 需求必要性矩阵与明确排除范围 (Necessity Matrix & Intentional Exclusions)

结合 Enkeep 作为 DSH 隔离沙箱多租户运行平台的架构特征，对 HappyClaw 业务能力进行必要性评估，划定 P0/P1/P2 优先级，并对明确排除项给出架构级论证。

### 3.1 功能域必要性评估矩阵 (P0 / P1 / P2)

```
+---------------------------------------------------------------------------------------------------+
|                                 Enkeep 功能域优先级演进规划                                         |
|                                                                                                   |
|  [P0: 首个自洽管理增量（已实现契约）]                                                                |
|  • 管理员仪表盘 (Admin Dashboard: GET /api/admin/dashboard)                                        |
|  • 用户状态管理与全量会话吊销 (GET /api/admin/users, PATCH /api/admin/users/:id,                   |
|    POST /api/admin/users/:id/revoke-sessions)                                                     |
|  • 空间聚合概况巡检 (GET /api/admin/spaces — 空间列表与各空间 sessionCount 统计)                    |
|  • 真实运行时容器与 7 插件就绪度探针 (GET /api/admin/runtime, GET /api/admin/plugins)               |
|  • 平台任务全局巡检 (GET /api/admin/tasks)                                                        |
|  • 消息投递与回执巡检 (GET /api/admin/deliveries — 强安全约束：零 Payload 返回)                      |
|  • 配额治理列表 (GET /api/admin/quotas — 核心指标: tokens/messages/turns/storage_bytes/api_calls)    |
|  • 安全审计日志流 (GET /api/admin/audit)                                                          |
|  • 固定导入凭据与来源溯源 (GET /api/admin/imports)                                                 |
|  • 安全与迁移状态 (GET /api/admin/security — 数据库 v1-v8 及 3000/3080 端口免疫)                     |
|  • 租户自服务门户 (Authenticated: GET /api/manage/overview|tasks|deliveries|quotas|audit|imports)   |
|  • 会话 Turn 历史查询 (Authenticated: GET /api/sessions/:id/turns)                                 |
|                                                                                                   |
|  [P1: 能力深化与编排增强（后续规划）]                                                               |
|  • Agent Profiles 四段 Prompt 治理面板 (IDENTITY / SOUL / AGENTS / TOOLS)                           |
|  • 工作区文件管理器 (File Explorer & Path Policy)                                                 |
|  • 工具调用与审批活动卡片 (Tool Activity Cards)                                                    |
|  • 自动化调度引擎 (Task Scheduler 语义与周期性触发器)                                               |
|  • 细粒度 Token 用量细目台账 (Usage Ledger)                                                        |
|  • 能力生态配置 UI (Capabilities / Skills / MCP 配置面板)                                          |
|                                                                                                   |
|  [P2: 高级生态与扩展功能（长期规划）]                                                               |
|  • 多账号渠道接入 UI (Channel Config)                                                             |
|  • 容器 Web 终端控制台 (Terminal Panel / WebSocket)                                               |
|  • 向量与语义记忆浏览器 (Memory Explorer)                                                         |
|  • 细粒度自定义角色与动态权限委派 (Custom RBAC Matrix)                                            |
|  • 管理员 PUT 修改配额与用户 Profile 变更 UI                                                       |
+---------------------------------------------------------------------------------------------------+
```

### 3.2 明确排除范围与架构合理性论证 (Intentional Exclusions)

为保障 Enkeep 本地隔离演示与生产级沙箱的纯粹性、安全性与确定性，以下功能在当前架构中**明确故意排除（Intentional Exclusions）**：

1. **排除真实外部 IM 渠道（No Real IM Integration）**：
   - **原因**：HappyClaw 支持飞书、微信、Telegram、Discord 等真实云端 Webhook。而 Enkeep 演示与沙箱环境运行在严格离线的局域网/Docker 内部，无公网入站反向代理；外部 IM 存在不可控的网络延迟与第三方外部依赖，违背纯净离线验证原则。
   - **替代方案**：通过 `@enkeep/web-channel` 实现基于标准信封规范（`InboundEnvelope` / `WebMessage`）的高性能 Web Channel 协议，配合 `delivery_inbox` 与 `idempotency_records` 提供确定性的消息投递与重放。
2. **排除外部 Provider 密钥存储与传输（No Provider Secrets in Transit/Storage）**：
   - **原因**：避免商业 API Key（如 Anthropic/OpenAI Token）泄露风险及因网络欠费/限流导致的不可预测性。
   - **替代方案**：使用容器内内置的 `DeterministicDemoLlmAdapter`（注册于 `demo-provider:demo-model`），完全离线生成前缀格式为 `[DemoModel:<user>] ...` 的确定性结构化响应；或在需要真实模型时通过本地挂载的离线推理端点交付。
3. **排除商业计费、Stripe 支付与充值卡兑换（No Commercial Billing / Payments）**：
   - **原因**：Enkeep 定位为企业私有化部署的多租户 Agent 编排平台，而非面向公众的 SaaS 计费运营系统。
   - **替代方案**：建立基于五大核心资源维度的平台配额治理体系（`tokens`、`messages`、`turns`、`storage_bytes`、`api_calls`），基于 `quota_limits`、`quota_usage`、`quota_reservations` 进行精确计量与预占扣减。
4. **排除普通用户 Host 模式执行与宿主机任意目录挂载（No Host Mode / Host Mounts for Demo）**：
   - **原因**：宿主机直接执行（Host Mode）具有完全突破沙箱的潜在风险，容易污染开发环境；挂载宿主机目录（`additional_mounts`）在不同操作系统（如 macOS Docker VM）下存在跨系统文件描述符与权限兼容陷阱。
   - **替代方案**：所有租户执行环境默认且严格限制在非 root（`UID:GID 1000:1000`）的 Docker 容器沙箱内，挂载专用的 Docker 独立卷（`enkeep-demo-dsh-<userId>`），杜绝跨租户卷共享与宿主机目录越界。

---

## 4. Enkeep 架构与实现演进分析 (Enkeep Architecture & Evolution Analysis)

### 4.1 前端交互与管理控制台 (Web UI & Console Tabs)
当前 `@enkeep/web-ui`（位于 `packages/web-ui/src/static/`）已由最初的单一 Chat 视图演进为集成管理控制台（Admin Management Console）与租户自服务中心（Tenant Self-Service Hub）的完整多标签单页应用：
- **聊天主界面**：包含登录、工作区 Spaces 选择、Session 列表、实时消息列表（`#messages-container`）及 Turn 执行状态。
- **管理员多标签控制台**：包含概览看板（Dashboard）、用户列表与状态切换（Users）、空间巡检（Spaces）、容器状态（Runtime）、7 插件就绪度（Plugins）、任务列表（Tasks）、投递收件箱（Deliveries）、配额治理（Quotas）、审计日志（Audit）、导入凭据（Imports）、安全迁移状态（Security）。
- **租户自服务中心**：普通用户可查看自身的概览、任务、投递、配额、审计与导入凭据。

### 4.2 后端数据与服务能力架构
Enkeep 后端具备企业级仓储与完备的底层业务支撑：
1. **持久化存储与迁移架构（`@enkeep/platform-storage-sqlite` & `@enkeep/platform-server`）**：
   - 已完整实现并通过严格测试的 **v1 至 v8 迁移**（`_schema_migrations` 具备 SHA-256 校验与防降级机制）。
   - 覆盖用户（`users`）、会话（`user_sessions`）、审计（`auth_audit_log`）、空间（`spaces`）、会话路由（`session_routes`）、会话来源（`session_sources`）、投递回执（`delivery_receipts`）、投递收件箱（`delivery_inbox`）、事件游标（`event_cursors`）、Turn 执行（`turn_runs`）、配额限制与预占（`quota_limits` / `quota_usage` / `quota_reservations`）、平台任务（`platform_tasks`）、文件元数据（`file_metadata`）、Web 消息与事件（`web_messages` / `web_events`）、幂等记录（`idempotency_records`）、固定导入凭据与溯源（`fixed_import_receipts` / `fixed_import_provenance`）。
2. **业务操作服务层（`@enkeep/platform-operations`）**：
   - 已实现 `MessageOperationService`、`FileOperationService`、`TaskOperationService`、`QuotaOperationService`，支持严密的租户隔离（`storage.forTenant(userId)`）与系统重启租户任务租赁扫描恢复（`recoverAfterRestart`）。
3. **认证与安全上下文（`@enkeep/platform-auth`）**：
   - 具备 Scrypt 密码哈希、HMAC-SHA256 签名 Cookie（`SameSite: Strict`）、单 Session 吊销（`revoke`）与全量吊销（`revokeAllForUser`）能力。
4. **运行时与隔离解耦设计（Injected Live Provider & Active Handles）**：
   - `platform-server` 与底层 Docker 客户端解耦：通过依赖注入的活体提供者（`ManagementRuntimeProvider` / Active Runtime Handles）获取实时容器与 7 插件状态，不产生硬编码依赖。
5. **固定导入器（`@enkeep/import-happyclaw`）**：
   - 具备严格的离线导入校验、指纹比对、幂等收件与消息来源溯源链。

---

## 5. 首个自洽管理增量规范 (First Coherent Management Increment)

首个自洽管理增量实现了企业级管理员控制台（Admin Management Console）以及租户自身的自助服务门户（Tenant Self-Service Portal），直接基于现有的 v1–v8 数据库与服务体系构建。

```
+---------------------------------------------------------------------------------------------------+
|                        Enkeep Management Console 首个自洽增量架构                                   |
|                                                                                                   |
|  +---------------------------------------------------------------------------------------------+  |
|  |                            Web UI (SPA Multi-Tab Console)                                  |  |
|  |  [Admin Only Tabs]                                                                         |  |
|  |  • 1. Dashboard (全局概览)   • 2. Users (用户状态与会话吊销) • 3. Spaces (空间聚合巡检)        |  |
|  |  • 4. Runtime (容器状态)    • 5. Plugins (7 插件就绪度)   • 6. Tasks (全平台任务流水)       |  |
|  |  • 7. Deliveries (投递巡检)  • 8. Quotas (配额消耗一览)    • 9. Audit (安全审计日志)         |  |
|  |  • 10. Imports (导入与溯源)  • 11. Security (迁移/端口状态)                                 |  |
|  |                                                                                             |  |
|  |  [Tenant Self-Service Hub (All Authenticated Users)]                                        |  |
|  |  • My Overview              • My Tasks                    • My Deliveries                   |  |
|  |  • My Quotas                • My Audit Logs               • My Import Receipts              |  |
|  +---------------------------------------------------------------------------------------------+  |
|                         │                                             │                           |
|                         ▼ Admin Role (/api/admin/*)                   ▼ Authenticated (/api/manage/*)
|  +---------------------------------------------------------------------------------------------+  |
|  |                                  Platform Server Routing                                    |  |
|  |  • Admin-Only Guard for /api/admin/* (Rejects non-admin with 403 Forbidden)                  |  |
|  |  • Authenticated Self-Service Guard for /api/manage/* (Scoped strictly to req.user.id)      |  |
|  |  • Privacy Guard: Admin does NOT browse private conversation messages                      |  |
|  |  • Strong Security: Zero delivery raw payloads returned in P0 API (Metadata/Status only)   |  |
|  |  • Live Runtime & Plugin Invariant: Real active handles probe or UNAVAILABLE (No Mock)      |  |
|  +---------------------------------------------------------------------------------------------+  |
|         │                                │                                │                       |
|         ▼                                ▼                                ▼                       |
|  +--------------------+         +--------------------+         +--------------------+             |
|  | PlatformStorage    |         | PlatformOperations |         | Injected Live      |             |
|  | (SQLite v1-v8)     |         | (Task/Quota/File)  |         | Runtime Provider   |             |
|  +--------------------+         +--------------------+         +--------------------+             |
+---------------------------------------------------------------------------------------------------+
```

### 5.1 管理控制台核心业务增量定位
该增量无需对数据库 Schema 进行任何变动，通过在 `platform-server` 实现对应的 HTTP 路由契约，并在 `web-ui` 呈现管理面板组件，即可让管理员和普通用户获得对其环境的完全掌控力。

### 5.2 管理员控制台（Admin Console）功能模块

1. **平台概览仪表盘 (Admin Dashboard: `GET /api/admin/dashboard`)**：
   - 汇总展示平台关键 KPI 指标卡片：总用户数（活跃/已禁用）、总空间数、总会话数、当前活动容器数、积压中（`held`）消息投递数、处理中（`processing`）任务数、近 24 小时认证失败事件数、数据库当前 Schema 版本。
2. **用户与访问控制 (`GET /api/admin/users`, `PATCH /api/admin/users/:id`, `POST /api/admin/users/:id/revoke-sessions`)**：
   - 用户列表查看（支持按角色 `admin`/`user`、状态 `active`/`disabled` 筛选）。
   - 用户状态管理：通过 `PATCH /api/admin/users/:id` 切换用户状态（`active` / `disabled`）。
   - 全量会话强制吊销：通过 `POST /api/admin/users/:id/revoke-sessions` 对指定用户执行全量会话强制登出（`revokeAllForUser`），目标用户后续请求即刻失效。
3. **空间聚合概况巡检 (`GET /api/admin/spaces`)**：
   - 跨租户查看全量 Spaces 聚合列表（包含所属用户 owner_username、空间名称 name、隔离目录 folder、执行模式 execution_mode、以及该空间关联的会话总数 `session_count`）。
   - **隐私保护边界**：管理员仅做空间级元数据与容量巡检，**绝对不提供普通用户私有会话消息历史的阅读与浏览接口**。
4. **容器运行状态 (`GET /api/admin/runtime`)**：
   - 实时容器健康探针：检测活动用户容器的存活状态（`healthy`/`starting`/`error`/`unavailable`）、容器名称/ID、网络模式（`none`）与 DSH 执行就绪状态（`dshReady`）。（注：遵循安全最小化原则，避免过度承诺底层宿主机内部卷与镜像路径细节）。
5. **7 插件就绪度监控 (`GET /api/admin/plugins`)**：
   - **7 大 Cordis 插件就绪度真实验证**（**严格执行无伪造规则**）：
     1. `receiptStore` (`@enkeep/dsh-receipt-store-sqlite`)
     2. `inbound` (`@enkeep/dsh-inbound`)
     3. `eventRelay` (`@enkeep/dsh-event-relay`)
     4. `tools` (`@enkeep/dsh-tools`)
     5. `externalInteraction` (`@enkeep/dsh-external-interaction`)
     6. `affinityPolicy` (`@enkeep/dsh-affinity-policy`)
     7. `llmAffinity` (`@tivility/dsh-llm-affinity`)
     若容器未运行或插件探针未就绪，明确标记为 `unavailable` 或 `offline`，严禁伪造“全部就绪”状态。
6. **平台任务管理 (`GET /api/admin/tasks`)**：
   - 展示 `platform_tasks` 任务流水（支持按状态 `pending`、`claimed`、`running`、`completed`、`failed`、`cancelled` 及优先级筛选）。
   - 查看任务租约过期时间（`lease_expires_at`）、认领次数（`claim_count`）、最大重试次数（`max_retries`）与失败错误信息。
7. **消息投递与幂等巡检 (`GET /api/admin/deliveries`)**：
   - 投递收件箱（`delivery_inbox`）与出站回执（`delivery_receipts`）监控：查看投递状态（`held`、`processing`、`delivered`、`duplicate`、`cancelled`、`failed`）。
   - **强安全约束（Zero Payload Return）**：在 P0 阶段，投递查询端点**完全不返回任何原始 Payload 字段**（仅返回 deliveryId、messageId、routeId、status、error、receivedAt、processedAt 等元数据），杜绝潜在敏感信息泄露。
8. **配额治理 (`GET /api/admin/quotas`)**：
   - 查看各租户的五大核心指标限制与已用量（`tokens`、`messages`、`turns`、`storage_bytes`、`api_calls`）及当前活动预占记录（`quota_reservations`）。（注：管理员 PUT 配额变更属于后续演进，P0 阶段提供只读治理大盘）。
9. **认证与操作审计 (`GET /api/admin/audit`)**：
   - 检索 `auth_audit_log` 安全日志（时间、用户、操作动作 `login`/`logout`/`login_failed`/`session_revoked`、IP 地址、UserAgent、详情）。
10. **固定导入凭据与数据溯源 (`GET /api/admin/imports`)**：
    - 查看离线导入凭据（`fixed_import_receipts`）：源数据库 SHA-256 指纹、导入器版本、源消息数 vs 导入有效消息数 vs 丢弃空消息数、附件数。
    - 溯源关联信息：展示目标 Space/Route 与原始 HappyClaw 会话的映射记录。
11. **安全防护与数据迁移状态 (`GET /api/admin/security`)**：
    - 展示已应用的 SQLite 迁移列表（版本 v1–v8、迁移名称、SHA-256 校验和、应用时间）。
    - 实时呈现系统安全守护状态：受保护端口（3000、3080）免疫状态、当前回环绑定端口（`127.0.0.1:<port>`）、CSRF 校验策略、CSP 安全策略。

### 5.3 租户自助服务视图 (`GET /api/manage/*` & `GET /api/sessions/:id/turns`)
普通用户（如 `bob`）登录后，可访问自身租户命名空间下的自服务视图（由服务端强制使用 `req.user.id` 作用域过滤）：
- **租户综合概览 (`GET /api/manage/overview`)**：查看本人的空间数、会话数、任务统计与配额汇总。
- **我的任务列表 (`GET /api/manage/tasks`)**：查看自身创建或被分配的后台任务执行进度。
- **我的投递状态 (`GET /api/manage/deliveries`)**：查看本人消息在系统中的投递与回执状态（同样严格执行零 Payload 返回）。
- **我的配额概览 (`GET /api/manage/quotas`)**：查看自身账户的五大核心资源（`tokens`、`messages`、`turns`、`storage_bytes`、`api_calls`）消耗及剩余额度。
- **我的安全审计 (`GET /api/manage/audit`)**：查看本人相关的登录、登出及安全审计日志。
- **我的导入凭据 (`GET /api/manage/imports`)**：查看历史导入至本人账户的数据凭证。
- **会话 Turn 历史明细 (`GET /api/sessions/:id/turns`)**：查询指定 Session 下已执行 Turn 的状态（`queued`、`running`、`completed`、`failed`、`interrupted`）。

---

## 6. 架构设计与技术实现规范 (Technical Specifications)

### 6.1 信息架构与导航层级 (Information Architecture & UI Navigation)

```text
[Enkeep Web Navigation Structure]
├── / (SPA Entry Point)
│   ├── [Unauthenticated]
│   │   └── Login View (用户名、密码、CSRF 保护)
│   │
│   ├── [Authenticated - General Console Views]
│   │   ├── 💬 Workspace (主会话聊天与工作区交互，支持 GET /api/sessions/:id/turns)
│   │   ├── 📊 Overview (自服务总览: GET /api/manage/overview)
│   │   ├── 📋 Tasks (任务列表: GET /api/manage/tasks 或 Admin 视角)
│   │   ├── 📬 Delivery (投递收件与回执: GET /api/manage/deliveries 或 Admin 视角)
│   │   ├── ⚖️ Quotas (配额消耗与预占: GET /api/manage/quotas 或 Admin 视角)
│   │   ├── 📜 Activity (审计日志: GET /api/manage/audit 或 Admin 视角)
│   │   └── 📦 Imports (数据导入与溯源: GET /api/manage/imports 或 Admin 视角)
│   │
│   └── [Authenticated - Admin Only Section (nav-admin-section)]
│       ├── 📈 Dashboard (平台全局大盘: GET /api/admin/dashboard)
│       ├── 👥 Users & Access (用户管理与会话吊销: GET /api/admin/users, PATCH .../status, POST .../revoke-sessions)
│       ├── 🗂️ Spaces & Sessions (空间与会话聚合巡检: GET /api/admin/spaces)
│       ├── 🐳 Runtime (容器运行状态探针: GET /api/admin/runtime)
│       ├── 🧩 Plugins (7 插件就绪度监控: GET /api/admin/plugins)
│       └── 🔒 Security (安全与迁移状态: GET /api/admin/security)
```

### 6.2 完整 REST API 接口契约表 (Exact Implementation Contract Table)

所有响应统一采用 `@enkeep/protocol` 标准信封格式：`{ success: true, data: T }` 或 `{ success: false, error: { code, message, status, details? } }`。非公开接口均需校验 HTTP Cookie Session 与 Host/CSRF 标头。

| 序号 | HTTP 方法 | API 路由端点 | 权限级别 | 请求 Payload / 查询参数 | 成功响应 Data 结构 | 核心错误码 |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **1** | `GET` | `/api/admin/dashboard` | Admin Only | 无 | `{ uptime: number, timestamp: string, counts: AdminDashboardCounts, runtime: { available: boolean, providerAttached: boolean, summary?: object } }` | `UNAUTHORIZED`, `FORBIDDEN` |
| **2** | `GET` | `/api/admin/users` | Admin Only | Query: `role?`, `status?`, `limit?`, `offset?` | `{ users: Array<Omit<User, 'passwordHash'>>, total: number }` | `UNAUTHORIZED`, `FORBIDDEN`, `VALIDATION_ERROR` |
| **3** | `PATCH` | `/api/admin/users/:id` | Admin Only | Body: `{ status: 'active' \| 'disabled' }` | `{ user: Omit<User, 'passwordHash'> }` | `NOT_FOUND`, `FORBIDDEN`, `VALIDATION_ERROR` |
| **4** | `POST` | `/api/admin/users/:id/revoke-sessions` | Admin Only | 无 | `{ revokedCount: number, userId: string }` | `NOT_FOUND`, `FORBIDDEN` |
| **5** | `GET` | `/api/admin/spaces` | Admin Only | Query: `userId?`, `search?`, `limit?`, `offset?` | `{ spaces: Array<{ id: string, userId: string, name: string, folder: string, executionMode: string, ownerUsername?: string, sessionCount: number }>, total: number }` | `UNAUTHORIZED`, `FORBIDDEN` |
| **6** | `GET` | `/api/admin/runtime` | Admin Only | 无 | `{ available: boolean, runtimes: Array<UserRuntimeStatus> }` | `UNAUTHORIZED`, `FORBIDDEN` |
| **7** | `GET` | `/api/admin/plugins` | Admin Only | 无 | `{ available: boolean, runtimes: Array<{ userId: string, status: string, dshReady: boolean, enkeepBundleLoaded: boolean, toolsCount: number, plugins: PluginReadinessStatus \| null }> }` | `UNAUTHORIZED`, `FORBIDDEN` |
| **8** | `GET` | `/api/admin/tasks` | Admin Only | Query: `userId?`, `status?`, `priority?`, `limit?`, `offset?` | `{ tasks: Array<PlatformTask>, total: number }` | `UNAUTHORIZED`, `FORBIDDEN` |
| **9** | `GET` | `/api/admin/deliveries` | Admin Only | Query: `userId?`, `status?`, `limit?`, `offset?` | `{ deliveries: Array<Omit<DeliveryInboxEntry, 'payload'>>, total: number }` *(注：零 Payload 返回)* | `UNAUTHORIZED`, `FORBIDDEN` |
| **10** | `GET` | `/api/admin/quotas` | Admin Only | Query: `userId?` | `{ quotas: Array<{ userId: string, username: string, limits: QuotaLimit[], usage: QuotaUsage[], activeReservationsCount: number }> }` *(核心指标: tokens/messages/turns/storage_bytes/api_calls)* | `UNAUTHORIZED`, `FORBIDDEN` |
| **11** | `GET` | `/api/admin/audit` | Admin Only | Query: `userId?`, `action?`, `limit?`, `offset?` | `{ logs: Array<AuthAuditLog>, total: number }` | `UNAUTHORIZED`, `FORBIDDEN` |
| **12** | `GET` | `/api/admin/imports` | Admin Only | 无 | `{ receipts: Array<FixedImportReceipt>, latestFingerprint?: string }` | `UNAUTHORIZED`, `FORBIDDEN` |
| **13** | `GET` | `/api/admin/security` | Admin Only | 无 | `{ migrations: MigrationRecord[], currentVersion: number, protectedPorts: { 3000: 'guarded', 3080: 'guarded' }, hostBinding: string, csrfEnforced: boolean }` | `UNAUTHORIZED`, `FORBIDDEN` |
| **14** | `GET` | `/api/manage/overview` | Authenticated | 无 | `{ user: Omit<User, 'passwordHash'>, spacesCount: number, sessionsCount: number, tasksCount: { total, pending, running }, quotaSummary: QuotaUsage[] }` | `UNAUTHORIZED` |
| **15** | `GET` | `/api/manage/tasks` | Authenticated | Query: `status?`, `limit?`, `offset?` | `{ tasks: Array<PlatformTask> }` | `UNAUTHORIZED` |
| **16** | `GET` | `/api/manage/deliveries` | Authenticated | Query: `status?`, `limit?`, `offset?` | `{ deliveries: Array<Omit<DeliveryInboxEntry, 'payload'>> }` *(注：零 Payload 返回)* | `UNAUTHORIZED` |
| **17** | `GET` | `/api/manage/quotas` | Authenticated | 无 | `{ limits: QuotaLimit[], usage: QuotaUsage[], reservations: QuotaReservation[] }` *(核心指标: tokens/messages/turns/storage_bytes/api_calls)* | `UNAUTHORIZED` |
| **18** | `GET` | `/api/manage/audit` | Authenticated | Query: `limit?`, `offset?` | `{ logs: Array<AuthAuditLog> }` | `UNAUTHORIZED` |
| **19** | `GET` | `/api/manage/imports` | Authenticated | 无 | `{ receipts: Array<FixedImportReceipt> }` | `UNAUTHORIZED` |
| **20** | `GET` | `/api/sessions/:id/turns` | Authenticated | 无 | `{ sessionId: string, turns: Array<TurnRun> }` | `NOT_FOUND`, `UNAUTHORIZED` |
| **21** | `GET` | `/api/sessions/:sessionId/turn/current` | Authenticated | 无 | `{ status: string, error?: string, result?: object }` | `NOT_FOUND`, `UNAUTHORIZED` |
| **22** | `POST` | `/api/sessions/:sessionId/turn/cancel-current` | Authenticated | Header: `Idempotency-Key` | `{ cancelled: boolean }` | `NOT_FOUND`, `CONFLICT`, `UNAUTHORIZED` |
| **23** | `GET` | `/api/turns/:turnId` | Authenticated | 无 | `{ status: string, error?: string, result?: object }` | `NOT_FOUND`, `UNAUTHORIZED` |
| **24** | `POST` | `/api/turns/:turnId/cancel` | Authenticated | 无 | `{ cancelled: boolean }` | `NOT_FOUND`, `UNAUTHORIZED` |
| **25** | `GET/POST` | `/api/manage/agent-profiles` | Authenticated | GET: query / POST: `CreateProfileRequest` | `{ items: SafeAgentProfileItem[], total }` / `{ profile: SafeAgentProfileDetail }` | `UNAUTHORIZED`, `VALIDATION_ERROR` |
| **26** | `POST` | `/api/spaces/:spaceId/files` | Authenticated | Body: `CanonicalFileOperationRequest` | `CanonicalFileOperationResult` (严格容器卷工作区隔离，支持 `list`/`read`/`write`/`mkdir`/`rename`/`delete` 非递归操作，强制 ETag 前提条件) | `NOT_FOUND`, `CONFLICT`, `VALIDATION_ERROR`, `UNAUTHORIZED` |

### 6.3 RBAC 权限与租户隔离规则 (RBAC & Multi-Tenant Isolation)

1. **绝对的主体身份解析（Server-Side Authority Resolution）**：
   - 所有的租户作用域 API 调用（`/api/manage/*`、`/api/spaces`、`/api/sessions`、`/api/sessions/:id/turns`、`/api/sessions/:id/turn/*`），其 `userId` **必须完全来源于服务端对加密 Session Cookie 的解密验证结果**（`platformApi.authenticateCookie`），绝不允许信任客户端在 Query/Body 中传入的伪造 `userId`。
2. **多租户数据强隔离（Strict Tenant-Scoped Repositories）**：
   - 非管理员用户访问业务数据时，底层仓储调用必须通过 `storage.forTenant(auth.user.id)` 获取租户专属仓储实例。任何跨租户的读取或写入尝试，底层自动以 `404 Not Found` 拒绝（避免向攻击者暴露其他租户资源的存在性）。
3. **管理端点强制鉴权（Admin Endpoint Guard）**：
   - 凡是属于 `/api/admin/*` 命名空间下的所有路由端点，必须在进入处理函数的第一时间校验 `auth.user.role === 'admin'`。若非管理员，直接抛出 `ForbiddenError('Access to privileged platform management APIs is denied')`（HTTP 403）。
4. **管理员破窗与隐私保护（Admin Oversight vs Privacy Boundary）**：
   - 管理员具备平台运维与空间聚合巡检权（可查看用户列表、空间聚合统计、任务流水、配额与审计日志），但**绝对不提供普通用户私有会话消息历史的浏览与导出接口**。任何管理员执行的用户状态修改（`PATCH /api/admin/users/:id`）或强制会话吊销（`POST /api/admin/users/:id/revoke-sessions`）操作，必须同步写入 `auth_audit_log` 审计表备查。

### 6.4 敏感字段脱敏与强安全约束 (Sensitive Field Redaction & Strong Omission)

在向 Web 客户端返回任何 JSON 数据前，序列化必须强制执行数据脱敏与字段剥离：
1. **凭证与内部哈希严格移除**：
   - `password_hash`、`token_hash`、`promptHash`、`secrets.json` 中的对称秘钥（`metaSecret`、`cookieSecret`）**绝对不可序列化至任何 API 响应中**（返回类型定义中排除或赋予 `undefined`）。`PublicAgentProfileSnapshot` 仅暴露 `version`、`identity`、`soul`、`agents`、`tools`、`changeSummary` 及 `createdAt`。
2. **投递 Payload 强安全约束（Zero Payload in P0）**：
   - 在管理员投递审计接口（`/api/admin/deliveries`）与租户投递接口（`/api/manage/deliveries`）中，**完全不返回 `delivery_inbox.payload` 原始数据**（相较于递归关键字遮蔽，采用完全剥离字段的强安全策略），仅展示结构化元数据（`deliveryId`、`routeId`、`status`、`error`、时间戳等）。
3. **会话令牌哈希脱敏**：
   - 用户 Session 相关信息均不返回底层 `token_hash`。

### 6.5 真实数据无伪造运行规则 (No-Fabrication Runtime Invariant)

为杜绝监控系统中的“虚假绿灯”，管理控制台必须遵循**真实现状报告原则（Zero Synthetic Health Checks）**：
1. **真实运行时状态探针**：
   - 当调用 `GET /api/admin/runtime` 时，后端通过注入的活体运行时提供者（Live Runtime Provider / Active Runtime Handles）检查真实容器/进程是否存活及状态。
   - 若运行时提供者未配置、容器未启动或健康检查失败（checkHealth 失败），状态如实返回 `available: false` 及 `unavailable` / `error` / `non-healthy`（活体 Provider Handle 仍可保持附着），**严禁返回预设的 Mock 存活状态**。
2. **7 大 Cordis 插件状态探针与零网络工具执行状态**：
   - 当调用 `GET /api/admin/plugins` 时，插件就绪度必须基于活体容器内部真实加载报告进行汇总。
   - 在零网络沙箱（`--network none`，无 UDS 套接字连接）中，`@enkeep/dsh-tools` 注册 4 个工具 Schema（`send_message`, `send_file`, `create_task`, `check_quota`），但由于平台客户端未挂载，`toolsOperational` 为 `false` 且原因代码为 `PLATFORM_CLIENT_UNAVAILABLE`。核心 6 插件与持久化正常加载。严禁伪造“工具执行已就绪”绿灯。

### 6.6 零 Schema 迁移论证 (No Schema Migration Rationale)

**技术论证结论：本管理控制台首个自洽增量完全基于现有的 v1–v8 SQLite 数据库 Schema 实现，零新增表、零字段修改、零破坏性变更。**

```
+---------------------------------------------------------------------------------------------------+
|                           已就绪的 SQLite Schema (v1-v8) 与管理能力映射                              |
|                                                                                                   |
|  [用户与会话管理] ────────► 表: users, user_sessions, auth_audit_log (v1)                           |
|  [空间与路由巡检] ────────► 表: spaces, session_routes (v1, v2), turn_runs (v1)                     |
|  [任务与队列管理] ────────► 表: platform_tasks (v4)                                                |
|  [配额与资源治理] ────────► 表: quota_limits, quota_usage, quota_reservations (v4)                 |
|  [消息与投递巡检] ────────► 表: delivery_inbox (v3, v6, v7), idempotency_records (v6)               |
|  [导入凭据与溯源] ────────► 表: fixed_import_receipts, fixed_import_provenance (v8)                 |
|  [迁移与安全状态] ────────► 表: _schema_migrations (v1-v8)                                         |
+---------------------------------------------------------------------------------------------------+
```

- **数据层支撑完备**：现有 v1 至 v8 已经具备管理控制台所需的全部数据模型（如用户权限、会话路由、任务流转、配额限制、投递幂等、导入凭证）。
- **仓储与操作层完备**：`@enkeep/platform-storage-sqlite` 与 `@enkeep/platform-operations` 已提供了所有必要的数据访问方法（如 `userRepo.list()`、`sessionRepo.revokeAllForUser()`、`taskRepo.list()`、`quotaRepo.getUsage()`、`migrations.getAppliedMigrations()`）。
- **因此**，仅需在平台服务层（`platform-server`）组装现有的仓储接口暴露标准 REST 端点，并在前端（`web-ui`）构建管理交互视图，即可实现功能自洽。

---

## 7. 分阶段演进路线图 (Phase Roadmap: P0 / P1 / P2)

```
+---------------------------------------------------------------------------------------------------+
|                                 Enkeep 管理演进三阶段路线图                                         |
|                                                                                                   |
|  【P0 阶段】首个自洽管理控制台（已实现落地的功能集）                                                 |
|   ├── 管理员全局 KPI 仪表盘 (GET /api/admin/dashboard)                                             |
|   ├── 用户管理与全量会话强制吊销 (GET /api/admin/users, PATCH .../users/:id,                       |
|   │   POST .../users/:id/revoke-sessions)                                                        |
|   ├── 空间聚合概况巡检 (GET /api/admin/spaces — 空间元数据与 sessionCount 统计)                     |
|   ├── 真实运行时容器与 7 插件就绪度监控 (GET /api/admin/runtime, GET /api/admin/plugins)           |
|   ├── 平台任务流水管理与认领重试监控 (GET /api/admin/tasks)                                         |
|   ├── 投递收件箱与回执监管 (GET /api/admin/deliveries — 零 Payload 强安全返回)                      |
|   ├── 租户配额限制与消耗治理 (GET /api/admin/quotas — 5 大核心指标)                                 |
|   ├── 认证与安全审计日志流检索 (GET /api/admin/audit)                                              |
|   ├── 历史数据导入凭据与溯源追溯 (GET /api/admin/imports)                                           |
|   ├── 安全与数据库迁移看板 (GET /api/admin/security)                                               |
|   ├── 租户自服务门户 (GET /api/manage/overview|tasks|deliveries|quotas|audit|imports)               |
|   └── 会话 Turn 执行记录查询 (GET /api/sessions/:id/turns)                                         |
|                                                                                                   |
|  【P1 阶段】能力生态深化与高级编排（后续规划）                                                      |
|   ├── Agent Profiles 治理工作室（IDENTITY / SOUL / AGENTS / TOOLS 四段 Prompt 编辑与版本历史）      |
|   ├── 工作区文件系统管理器（File Explorer、安全路径策略限制与下载预览）                             |
|   ├── 工具调用与审批卡片（Tool Activity & Approval Cards，支持外部交互挂起与确认）                  |
|   ├── 自动化调度引擎（Task Scheduler 语义，支持 Cron / Interval 周期性触发与补跑）                   |
|   ├── 细粒度 Token 消耗台账（按 Space、Session、Model 维度的多维用量分析报表）                     |
|   └── 能力与工具生态可视化配置（Skills / Tools / External Interaction 配置面板）                    |
|                                                                                                   |
|  【P2 阶段】高级生态接入与深度管控（长期规划）                                                      |
|   ├── 多账号企业级渠道接入管理（当引入外部受控渠道代理时）                                          |
|   ├── 容器内置 Web 终端（基于 WebSocket / xterm.js 的安全交互终端，具备严格 RBAC）                 |
|   ├── 向量与长期记忆管理器（Memory Search & Pruning UI）                                            |
|   ├── 自定义细粒度权限矩阵配置（Dynamic Role & Policy Delegation）                                 |
|   └── 管理员 PUT 修改配额与用户 Profile 变更 UI                                                     |
+---------------------------------------------------------------------------------------------------+
```

---

## 8. 验收标准与测试验证矩阵 (Acceptance Criteria & Test Matrix)

为确保管理控制台的技术实现与架构设计完全吻合，特制定全方位的验收标准与验证矩阵：

### 8.1 单元测试与仓储隔离验收 (Unit & Repo Isolation)
- **验证命令**：`pnpm run test:packages`
- **验收准则**：
  1. `SqliteUserRepository` 针对用户列表过滤、状态更新与角色统计的测试 100% 通过。
  2. `SqliteUserSessionRepository` 针对单个 `revoke(id)` 及全量 `revokeAllForUser(userId)` 的测试 100% 通过，被吊销的 Session 再次认证时必须被拒绝。
  3. `SqliteAuthAuditLogRepository` 的分页与动作过滤查询测试通过。
  4. `SqlitePlatformOperationsStorage` 的多租户隔离断言通过（租户 A 绝对无法读取租户 B 的任务、配额与文件元数据）。

### 8.2 API 集成与契约验收 (API Integration & Contract)
- **验证命令**：`pnpm --filter @enkeep/platform-server test`
- **验收准则**：
  1. 所有 `/api/admin/*` 端点在普通用户（如 `bob`）Cookie 访问时返回 HTTP 403 `ForbiddenError`。
  2. 所有 `/api/manage/*` 端点要求登录认证，非登录请求返回 HTTP 401 `UnauthorizedError`；登录后严格按 `req.user.id` 返回数据。
  3. 管理员（如 `alice`）能够正常访问 `/api/admin/*` 端点，且返回数据均符合标准信封结构。
  4. 强安全脱敏规则校验：返回的用户对象中绝对不包含 `password_hash`，Session 中不包含 `token_hash`，投递接口完全不包含 `payload` 字段（零 Payload 返回）。
  5. 明确边界：当前 P0 实现中不包含未定义的写接口（如用户创建、密码修改、个人 Profile 变更、单 Session 吊销或管理员配额修改）。
  6. 接口输入校验：非法的分页参数、Malformed JSON Body、未知字段注入均被拒绝并返回 HTTP 400。

### 8.3 浏览器端 UI 交互验收 (Browser & Web UI Tests)
- **验证命令**：`pnpm --filter @enkeep/web-ui test` 及 `pnpm --filter @enkeep/web-e2e test`
- **验收准则**：
  1. `@enkeep/web-ui` 单元与集成测试通过，包含通用控制台（Console）与管理员专区（Administration）导航分发与权限感知逻辑。
  2. 管理员登录后，左侧导航栏显示 Administration 专属专区（Dashboard、Users & Access、Spaces & Sessions、Runtime、Plugins、Security），且与通用控制台视图可流畅切换。
  3. 在 Users & Access 界面中点击“全量会话吊销”或“禁用用户”后，目标用户的会话在服务端即刻作废；目标用户在发起下一次认证请求时将收到 HTTP 401，前端触发重定向至登录页（P0 阶段不依赖瞬时推送，以服务端鉴权失效为准）。
  4. 普通用户登录后，不展示 Administration 专属专区，仅可在通用控制台视图中查看自身租户作用域的数据（Overview、Tasks、Delivery、Quotas、Activity、Imports）。

### 8.4 Docker 沙箱与运行时验收 (Docker Sandbox Acceptance - Planned)
- **验证命令**：`pnpm run test:docker`
- **验收准则**（需在完整 Docker 运行环境下执行验证）：
  1. `GET /api/admin/runtime` 能够如实返回活动 Docker 容器元数据（网络配置 `none`、容器 ID 与状态）。
  2. 当 Docker 容器健康检查失败或外部异常中断时，接口如实返回 `unavailable` / `error` / `non-healthy`，无任何虚假上报。
  3. `GET /api/admin/plugins` 接口能够如实反映 7 大 Cordis 插件的真实加载状态。

### 8.5 故障恢复与幂等重放验收 (Crash Recovery & Idempotency)
- **验证命令**：`pnpm --filter @enkeep/platform-storage-sqlite test`
- **验收准则**：
  1. 系统意外重启后，调用 `recoverAfterRestart` 能够原子化将遗留的 `processing` 投递状态重置为 `held`，将运行中的 `turn_runs` 标记为 `interrupted`。
  2. 幂等消息重复提交时，直接返回已处理的响应 Payload，不重复触发下游 Agent 运行。

### 8.6 安全预检与动态绑定端口验收 (Safety Preflight & Dynamic Port 127.0.0.1)
- **验证命令**：`pnpm run safety:test` 及 `pnpm run preflight`
- **验收准则**：
  1. 服务端监听 host `127.0.0.1` 端口 `0`，尝试绑定 `0.0.0.0` 或其他非回环公共接口时抛出 `UnsafeHostBindingError`（或对应 PlatformError）。
  2. 严格的 Host 与 Origin 请求头校验生效，非 `127.0.0.1:<socketPort>` 的请求直接被拦截。
  3. 所有生成的密码秘钥文件严格受限于 `<repoRoot>/.demo-data/` 内部。

### 8.7 端口 3000 与 3080 零干扰免疫验证 (Port 3000/3080 Immunity)
- **验收准则**：
  1. 在所有自动化测试与 Demo 启动运行前后，安全套件仅执行 `lsof`/TCP 连通性探针以验证进程身份与端口存活，绝不发送任何应用层业务流量或写入请求。
  2. 严禁向端口 3000（HappyClaw）和 3080（DSH GUI）发起应用请求或终止信号，确保监听 PID 与端口状态完全不变。

---

## 9. 核心契约与治理规则 (Core Governance Contracts)

- **后台任务契约 (Tasks - `agent_prompt`)**：
  - 任务 Payload 契约严格遵循 `AgentPromptTaskPayload`：`{ type: 'agent_prompt', prompt: string, sessionId: string, sessionPolicy: 'existing_session', spaceId?: string }`。
- **配额治理 (Quotas - 5 Fixed Metrics)**：
  - 严格支持 5 项固定核心指标：`tokens`、`messages`、`turns`、`storage_bytes`、`api_calls`。
  - 未配置配额策略默认为严格 `fail_closed`。
  - 配额预占遵循原子 CAS 状态转移（`reserved` -> `committed` / `released` / `expired`），在 Turn 取消或失败时自动释放。
- **容器卷文件工作区 (Files Workbench)**：
  - 严格限制在租户容器卷工作区（`/api/spaces/:spaceId/files*`）。
  - 支持非递归操作：`list`、`read`、`write`、`mkdir`、`rename`、`delete`。
  - 严格 ETag 前提条件：`mkdir` 必须提供 `{ requireAbsent: true }`；`write` 必须提供 `expectedEtag` 或 `requireAbsent: true`；`rename` 必须提供 `expectedEtag` 与 `expectedTargetEtag` 或 `requireTargetAbsent: true`；`delete` 必须提供 `expectedEtag`。ETag 必须为 64 位小写 SHA-256 十六进制字符串。
- **Agent Profile 四段 Prompt 治理**：
  - 四段 Prompt 架构：`IDENTITY`、`SOUL`、`AGENTS`、`TOOLS`。
  - 不可变版本历史（正整数 `1, 2, 3...`），基于规范 JSON 计算 SHA-256 promptHash。
  - 空间绑定与 Generation 快照锁定：空间绑定激活版本；Session 在 generation 边界处锁定快照。
  - 归档机制：支持软归档（状态变为 `archived`），已存在会话继续保留快照，已归档 Profile 禁止新空间绑定。
- **脱敏与隐私保护 (Public IDs & Privacy)**：
  - 严格过滤内部敏感凭据与哈希字段（`password_hash`、`token_hash`、`promptHash`、HMAC 密钥）。`PublicAgentProfileSnapshot` 仅暴露 `version`、`identity`、`soul`、`agents`、`tools`、`changeSummary` 与 `createdAt`。

---

## 10. 明确排除项与系统边界 (Intentional Exclusions)

- **无真实外部 IM 渠道**：不提供与飞书 (Feishu)、微信 (WeChat)、Telegram、Discord 等外部即时通信系统的实时集成。
- **无外部凭证接入**：不接受、存储或传输真实大模型提供商 API Token 或密钥。
- **无动态/任意数据导入**：历史数据迁移仅支持仓库固化的测试固件（`packages/import-happyclaw/fixtures/source/db/messages.db`，精确不变量：2 chats, 52 source messages, 50 imported, 2 dropped, 5 attachments），严禁读取外部 HappyClaw 生产数据库。
- **无宿主机执行模式**：用户代码、工具命令及 Agent Turn 仅在零网络 Docker 沙箱容器内执行，严禁在宿主机直接执行。
- **无任意宿主机目录挂载**：严禁挂载 `/var/run/docker.sock`、宿主机 `$HOME`、`~/.dsh`、`/etc` 或任意自定义宿主机目录（`additional_mounts`）。
- **无外部 MCP 与动态插件**：不支持外部 Stdio/SSE Model Context Protocol 服务及未经审计的动态外部插件。
- **无宿主机 Git / Shell Skills**：不提供宿主机级 Git 操作技能或 Shell 技能。

---

## 11. 状态与验证声明 (Implementation Status & Verification)

- **实现状态**：
  - **后端接口与数据源**：`platform-server` 实现了管理员端点（`/api/admin/...`）及租户自服务端点（`/api/manage/...`）、会话 Turn 端点（`GET /api/sessions/:id/turns`、`GET /api/sessions/:sessionId/turn/current`、`POST /api/sessions/:sessionId/turn/cancel-current`）。
  - **前端管理控制台**：`@enkeep/web-ui` 实现了多标签管理控制台与自服务门户的组件集成与状态管理。
  - **安全与隔离**：严格遵循零 Payload 投递返回、无伪造运行时探针、零网络沙箱（4 个 Tool Schemas 注册但 `toolsOperational: false`，原因 `PLATFORM_CLIENT_UNAVAILABLE`，核心 6 插件及持久化正常运行）。
- **验证状态**：
  - `pnpm run safety:test`（50/50 测试已验证通过）
  - 其余测试套件（如 `platform-server`、`web-ui`、`web-e2e`、`test:docker`）在全量工作区重构演进中持续按代码契约进行回归验证。
