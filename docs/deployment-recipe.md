# Enkeep 生产部署与受控发布/回滚操作配方 (Deployment & Release Recipe)

> **适用范围**: Enkeep 平台基础设施与运行时服务受控发布 (G15 机制固化)。  
> **核心原则**: 基于经审查的 Git 提交在版本化隔离工作树（Isolated Worktree）中构建与发布；macOS LaunchAgent (`com.owner-user.enkeep`) 为唯一官方支持的长期常驻运行模式；严禁在脏工作区（Dirty Workspace）直接部署；保留生产数据库与 Docker Volume；严禁无差别强杀进程或删除数据库；严禁在发布与验证中调用飞书/微信外部信道 API；严禁无监督生产自主热自升级。

---

## 1. 架构拓扑与关键目录基线 (Topology & Path References)

### 1.1 核心服务端口与进程边界
- **Enkeep 平台服务**: 端口 `http://127.0.0.1:3900`（由 macOS LaunchAgent `com.owner-user.enkeep` 独占守护，PPID 为 `1`；反向代理映射 `http://127.0.0.1:3901`，由 Launchd `com.owner-user.local-proxy` 守护）。
- **DSH Web 服务 (保护目标)**: 端口 `http://127.0.0.1:3080`（严禁终止或干扰）。
- **HappyClaw 服务 (保护目标)**: 端口 `http://127.0.0.1:3000`（严禁终止或干扰）。
- **容器运行时**: Docker 引擎（容器名 `enkeep-demo-*`，网络模式 `--network none`，数据卷 `enkeep-demo-dsh-*`）。

### 1.2 物理路径与环境引用 (Path & Env References)
- **工作区根目录**: `<workspace-root>`
- **Enkeep 仓根目录 (`repoRoot`)**: `<workspace-root>/enkeep`
- **生产持久数据目录 (`dataDir`)**: `<workspace-root>/enkeep/.demo-data`
- **生产 SQLite 数据库**: `<workspace-root>/enkeep/.demo-data/platform.db`
- **外部受管配置目录**: `<enkeep-config-dir>`
- **快照与备份目录**: `<enkeep-config-dir>/snapshots`
- **能力清单路径**: `<enkeep-config-dir>/pipeline-task-capabilities.json`
- **LaunchAgent Plist 路径**: `~/Library/LaunchAgents/com.owner-user.enkeep.plist`
- **服务日志路径**: `~/Library/Logs/enkeep.log` (stdout), `~/Library/Logs/enkeep.err` (stderr)
- **版本化隔离工作树**: `<workspace-root>/reports/hc-vs-enkeep/implementation/release-worktree-<batchId>`

---

## 2. 严禁事项与防误操作红线 (Strict Prohibitions & Invariants)

1. **唯一常驻模式: 严禁 DSH 后台作业/nohup (LaunchAgent is the ONLY Supported Long-Running Mode)**:
   - **历史教训**: 先前通过 DSH Harness Managed Background Job (`run_in_background`) 启动守护进程，当 DSH 作业宿主会话结束时会导致 3900 端口服务意外终止并引发故障停机。
   - **铁律**: macOS LaunchAgent (`com.owner-user.enkeep`) 是生产与测试环境中**唯一受支持的常驻模式**。严禁在 DSH background jobs / nohup 下运行 Enkeep 主服务。
2. **严禁无差别强杀 PID (No Blind Process Killing)**:
   - 绝不允许使用 `pkill -f node` 或模糊杀进程命令。
   - 服务启停完全通过 `launchctl bootout` / `bootstrap` 由 launchd 管理。
3. **严禁删除或重置生产数据库 (No Database Deletion)**:
   - 严禁删除 `.demo-data/platform.db`、`platform.db-wal` 或 `platform.db-shm`。
   - Schema 迁移遵循向后兼容原则（当前维持 `37`），发布与回滚均不得整库覆盖或清空。
4. **严禁删除 Docker 持久卷 (Preserve Volumes)**:
   - 容器启停严禁传入 `--remove-vols` 或执行 `docker volume rm`，必须完整保留 `enkeep-demo-dsh-*`。
5. **严禁在健康检查中调用飞书/微信外部信道 API (No Feishu/WeChat Tests)**:
   - 验证仅使用通用只读端点与本地 CLI 鉴权；0 飞书/微信测试消息，0 云端资源变更，生产信道保持自然在线。
6. **严禁在代码与文档中硬编码秘钥明文 (No Raw Secrets)**:
   - 仅引用受管私有配置文件路径与环境变量名称，文档和 Plist 中绝不暴露明文 Secret。
7. **严禁无监督生产自升级 (No Autonomous In-Band Self-Upgrade API)**:
   - 生产环境严禁通过在途对话会话触发无监督的进程自杀式重启；所有发布必须有显式操作员授权，由外部守护器托管。

---

## 3. 标准受控发布八步法 (8-Step Controlled Release Procedure)

```
[1. 隔离构建] ──> [2. 只读预检] ──> [3. 负载排空与全域预检] ──> [4. 人工确认]
                                                                        │
[8. 秒级回滚] <── [7. 拓扑验证] <── [6. LaunchAgent更新] <── [5. 预检停机重载]
```

### 步骤 1: 隔离工作树创建与产物构建 (Build & Image Packaging)
必须从已审查通过的分支/提交（如 `refs/heads/release/batch5`）创建纯净隔离工作树并编译，严禁在主脏工作区直接构建发布制品：
```bash
# 1. 建立版本化工作树 (以 batch5 为例)
git worktree add reports/hc-vs-enkeep/implementation/release-worktree-batch5 refs/heads/release/batch5

# 2. 在隔离工作树中编译
cd reports/hc-vs-enkeep/implementation/release-worktree-batch5
pnpm run build:root && pnpm -r run build

# 3. 构建 Docker 运行时镜像
docker build -f docker/Dockerfile.runtime -t enkeep-runtime:gap-batch5-$(git rev-parse --short HEAD) .
```

### 步骤 2: 只读预检与数据库原子快照 (Preflight & DB Snapshot)
运行只读预检脚本验证工作树与产物完整性，并生成 SQLite 热备份：
```bash
# 执行只读安全预检
node enkeep/scripts/release-preflight.mjs --release-id batch5

# 数据库原子快照热备份 (VACUUM INTO，不锁表且不影响正在进行的只读读取)
sqlite3 <workspace-root>/enkeep/.demo-data/platform.db \
  "VACUUM INTO '<enkeep-config-dir>/snapshots/platform.db.pre-batch5-vacuum';"
```

### 步骤 3: 负载排空与全域运行时预检 (Drain Gate & Runtime-Aware Preflight)
在停机前不仅需要核验 `platform.db`，还必须核验所有宿主守护进程（Host Daemon）及容器运行时（Container Runtime）内部的在途工作。
历史故障教训表明：纯平台层 SQL 查询无法观察到宿主运行时内由于工作流作业结束所触发的**自主延续轮次（autonomous continuation turn）**、在途后台作业/工作流、实时子代理与会话待处理收件箱（inbox）。
因此必须使用 `demo-runner preflight` 进行全域只读状态聚合：
```bash
# 全域只读负载与在途状态预检 (聚合平台数据库与所有宿主/容器运行时 Daemon RPC 活动)
node <release-worktree>/packages/demo-runner/dist/demo-runner.js preflight \
  --data-dir $ENKEEP_DATA_DIR \
  --due-within-minutes 10
```
该命令会自动检查：
1. 平台状态：活跃/排队轮次 (`turn_runs`, `turn_execution_queue`)、领取的任务与活跃租约 (`task_runs`, `session_execution_leases`)、未终态事务日志 (`file_transfer_journal`, `attachment_snapshot_journal`, `daemon-turns`)、N 分钟内到期的定时任务；
2. 运行时状态：向每个常驻宿主守护进程与容器运行时发起 RPC 请求，核验活跃轮次（包括自主延续轮次）、运行中作业（包括 workflow 作业）、实时子代理、待处理收件箱项；
3. 任一组件非空闲时立即输出明细并以非零状态码退出。

辅助核验 SQL：
```sql
SELECT count(*) FROM turn_runs WHERE status = 'running';              -- 必须为 0
SELECT count(*) FROM turn_execution_queue;                            -- 必须为 0
SELECT count(*) FROM task_runs WHERE status IN ('running', 'claimed');-- 必须为 0
SELECT count(*) FROM session_execution_leases WHERE status = 'active';-- 必须为 0
```

### 步骤 4: 人工操作员确认 (Operator Confirmation Gate)
> **安全门禁**: 生产发布必须由人工操作员显式授权。严禁会话内子代理在无外部监督情况下擅自触发自身宿主重启。

### 步骤 5: 原子预检停机与重载启动 (Preflighted Shutdown & Service Switch)
> **强一致性要求**: `demo-runner preflight` 必须在紧随 `stop`（`launchctl bootout`）之前、且**必须在与 stop/start 相同的单一命令调用行（同一 invocation）**中执行。若预检发现任何平台或运行时活动，命令链立即熔断非零退出，杜绝停机操作丢弃在途自主轮次或后台作业：

```bash
# 原子预检停机与启动重载单行调用 (同一 invocation 中严格前置 preflight)
node <release-worktree>/packages/demo-runner/dist/demo-runner.js preflight --data-dir $ENKEEP_DATA_DIR && \
  launchctl bootout gui/$(id -u)/<launchd-label> && \
  launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/<launchd-label>.plist
```

### 步骤 6: LaunchAgent 配置更新与重载启动 (LaunchAgent Switch & Bootstrap)
Enkeep 生产运行由 `~/Library/LaunchAgents/com.owner-user.enkeep.plist` 定义。发布切换即更新 Plist 中的工作树路径与镜像 Tag，然后通过 launchctl bootstrap 重新挂载：

#### 1. Plist 字段结构规范 (`com.owner-user.enkeep.plist`):
- `Label`: `com.owner-user.enkeep`
- `ProgramArguments`:
  - Node 解释器路径 (如 `/opt/homebrew/bin/node`)
  - 目标版本工作树产物路径 (如 `<workspace-root>/reports/hc-vs-enkeep/implementation/release-worktree-batch5/packages/demo-runner/dist/demo-runner.js`)
  - `up`
  - `--port` `3900`
  - `--network-mode` `none`
  - `--allow-host`
  - `--repo-root` `<workspace-root>/enkeep`
- `WorkingDirectory`: `<workspace-root>/enkeep`
- `EnvironmentVariables` (仅配置非敏感系统环境变量与运行时参数，绝无明文 Secret):
  - `HOME`: `~`
  - `PATH`: `/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`
  - `ENKEEP_RUNTIME_IMAGE`: `enkeep-runtime:gap-batch5-81034eb`
  - `ENKEEP_PIPELINE_MANIFEST`: `<enkeep-config-dir>/pipeline-task-capabilities.json`
  - `ENKEEP_DSH_HOME`: `<enkeep-config-dir>/dsh-home`
  - `DSH_WEB_URL`: `http://127.0.0.1:3080`
  - `ENKEEP_CONTEXT_WINDOW_DEFAULT`: `272000`
- `StandardOutPath`: `~/Library/Logs/enkeep.log`
- `StandardErrorPath`: `~/Library/Logs/enkeep.err`
- `KeepAlive`: `<true/>`
- `RunAtLoad`: `<true/>`
- `ThrottleInterval`: `10`

#### 2. 切换发布与重载命令:
```bash
# 1. 编辑 Plist 中的 ProgramArguments 工作树路径与 ENKEEP_RUNTIME_IMAGE 标签
# 2. 校验 Plist 语法
plutil -lint ~/Library/LaunchAgents/com.owner-user.enkeep.plist

# 3. 载入并启动 LaunchAgent
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.owner-user.enkeep.plist
```

### 步骤 7: 拓扑隔离与全量健康验证 (Verification)
验证新版本已脱离 DSH 独立运行在 launchd 下，严禁调用飞书/微信外部信道：
```bash
# 1. Launchd 服务运行状态
launchctl print gui/$(id -u)/com.owner-user.enkeep | grep -E "state =|pid ="

# 2. 进程树与 PPID 验证 (PPID 必须为 1，直接父进程为 launchd)
ps -o pid,ppid,command -p $(lsof -ti :3900)

# 3. DSH 作业解耦确认 (确保 DSH 内部无托管作业)
# 在 DSH 中确认 job_list 为空

# 4. Web 控制台可达性 (HTTP 200)
curl -s -i http://127.0.0.1:3900/ | grep -q "200 OK"

# 5. CSRF 鉴权凭证接口
curl -s http://127.0.0.1:3900/api/auth/csrf | grep -q "csrfToken"

# 6. 本地通用账号登录与空间查询
node reports/hc-vs-enkeep/bench/ek.mjs login
node reports/hc-vs-enkeep/bench/ek.mjs spaces

# 7. 反向代理端口可达性 (HTTP 200)
curl -s -i http://127.0.0.1:3901/ | grep -q "200 OK"

# 8. Docker 容器拓扑核验 (3 个 demo 容器处于 Up 状态且 network=none)
docker ps --filter "name=enkeep-demo-"
```

### 步骤 8: 快速回滚预案 (Instant Rollback without DB Restore)
若健康验证未通过，执行秒级回滚：
1. **停止当前实例**: `launchctl bootout gui/$(id -u)/com.owner-user.enkeep`；
2. **切回前一稳定版本**: 编辑 `~/Library/LaunchAgents/com.owner-user.enkeep.plist`，将 `ProgramArguments` 路径和 `ENKEEP_RUNTIME_IMAGE` 重新指向前一稳定版本工作树与镜像（如 `release-worktree-batch4` 与 `enkeep-runtime:gap-batch4-4de11b1`）；
3. **重载启动**: 执行 `plutil -lint ~/Library/LaunchAgents/com.owner-user.enkeep.plist && launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.owner-user.enkeep.plist`；
4. **数据库严禁回滚还原 (Never DB Restore unless explicitly approved)**: 数据库 Schema 保持向后兼容（Schema `37`），业务数据完好保留，严禁覆盖生产 `platform.db`。

---

## 4. 交付能力边界与常驻运行机制说明 (Deliverable Limits & Operational Model)

1. **常驻守护隔离机制**:
   - 生产环境采用系统级守护进程 `launchd`（LaunchAgent `com.owner-user.enkeep`）进行生命周期托管，实现服务与 DSH 会话的物理脱钩（PPID = 1），彻底杜绝会话结束导致的进程级连回收。
2. **自主自升级边界 (Autonomous Self-Upgrade NOT Bench-Tested)**:
   - 当前在途会话内的**全自动无人值守热升级（Autonomous In-Turn Self-Upgrade）尚未经过端到端基准压力测试**。
   - 现网已成功验证的机制为“受控流水线 + 隔离工作树构建 + 操作员显式授权 + LaunchAgent Plist 切换重载”。
