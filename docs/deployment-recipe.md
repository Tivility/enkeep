# Enkeep 生产部署与受控发布/回滚操作配方 (Deployment & Release Recipe)

> **适用范围**: Enkeep 平台基础设施与运行时服务受控发布 (G15 机制固化)。  
> **核心原则**: 基于经审查的 Git 提交在版本化隔离工作树（Isolated Worktree）中构建与发布；严禁在脏工作区（Dirty Workspace）直接部署；保留生产数据库与 Docker Volume；严禁无差别强杀进程或删除数据库；严禁在发布与验证中调用飞书/微信外部信道 API；严禁无监督生产自主热自升级。

---

## 1. 架构拓扑与关键目录基线 (Topology & Path References)

### 1.1 核心服务端口与进程边界
- **Enkeep 平台服务**: 端口 `http://127.0.0.1:3900`（反向代理映射 `http://127.0.0.1:3901`，Launchd `com.owner-user.local-proxy`）。
- **DSH Web 服务 (保护目标)**: 端口 `http://127.0.0.1:3080`（PID `31699`/`36567`，严禁终止或干扰）。
- **HappyClaw 服务 (保护目标)**: 端口 `http://127.0.0.1:3000`（PID `60574`，严禁终止或干扰）。
- **容器运行时**: Docker 引擎（容器名 `enkeep-demo-*`，网络模式 `--network none`，数据卷 `enkeep-demo-dsh-*`）。

### 1.2 物理路径与环境引用 (Path & Env References)
- **工作区根目录**: `<workspace-root>`
- **Enkeep 仓根目录 (`repoRoot`)**: `<workspace-root>/enkeep`
- **生产持久数据目录 (`dataDir`)**: `<workspace-root>/enkeep/.demo-data`
- **生产 SQLite 数据库**: `<workspace-root>/enkeep/.demo-data/platform.db`
- **外部受管配置目录**: `<enkeep-config-dir>`
- **快照与备份目录**: `<enkeep-config-dir>/snapshots`
- **能力清单路径**: `<enkeep-config-dir>/pipeline-task-capabilities.json`
- **版本化隔离工作树**: `<workspace-root>/reports/hc-vs-enkeep/implementation/release-worktree-<batchId>`

---

## 2. 严禁事项与防误操作红线 (Strict Prohibitions & Invariants)

1. **严禁无差别强杀 PID (No Blind Process Killing)**:
   - 绝不允许使用 `pkill -f node` 或模糊杀进程命令。
   - 停机仅向正在监听 3900 端口的特定 Enkeep 进程发送 `SIGTERM`。
2. **严禁删除或重置生产数据库 (No Database Deletion)**:
   - 严禁删除 `.demo-data/platform.db`、`platform.db-wal` 或 `platform.db-shm`。
   - Schema 迁移遵循向后兼容原则（当前版本维持 `37`），发布与回滚均不得整库覆盖或清空。
3. **严禁删除 Docker 持久卷 (Preserve Volumes)**:
   - 容器启停严禁传入 `--remove-vols` 或执行 `docker volume rm`，必须完整保留 `enkeep-demo-dsh-*`。
4. **严禁在健康检查中调用飞书/微信外部信道 API (No Feishu/WeChat Tests)**:
   - 验证仅使用通用只读端点与本地 CLI 鉴权；0 飞书/微信测试消息，0 云端资源变更，生产信道保持自然在线。
5. **严禁在代码与文档中硬编码秘钥明文 (No Raw Secrets)**:
   - 仅引用受管私有配置文件路径（如 `secrets.json`），绝不暴露明文 Token。
6. **严禁无监督生产自升级 (No Autonomous In-Band Self-Upgrade API)**:
   - 生产环境严禁通过在途对话会话触发无监督的进程自杀式重启；所有发布必须有显式操作员授权或外部守护器托管。

---

## 3. 标准受控发布八步法 (8-Step Controlled Release Procedure)

```
[1. 隔离构建] ──> [2. 只读预检] ──> [3. 负载排空] ──> [4. 人工确认]
                                                            │
[8. 秒级回滚] <── [7. 通用验证] <── [6. 托管启动] <── [5. 优雅停机]
```

### 步骤 1: 隔离工作树创建与产物构建 (Build & Image Packaging)
必须从已审查通过的分支/提交（如 `refs/heads/release/batch4`）创建纯净隔离工作树并编译，严禁在主脏工作区直接构建发布制品：
```bash
# 1. 建立版本化工作树 (以 batch4 为例)
git worktree add reports/hc-vs-enkeep/implementation/release-worktree-batch4 refs/heads/release/batch4

# 2. 在隔离工作树中编译
cd reports/hc-vs-enkeep/implementation/release-worktree-batch4
pnpm run build:root && pnpm -r run build

# 3. 构建 Docker 运行时镜像
docker build -f docker/Dockerfile.runtime -t enkeep-runtime:gap-batch4-$(git rev-parse --short HEAD) .
```

### 步骤 2: 只读预检与数据库原子快照 (Preflight & DB Snapshot)
运行只读预检脚本验证工作树与产物完整性，并生成 SQLite 热备份：
```bash
# 执行只读安全预检
node enkeep/scripts/release-preflight.mjs --release-id batch4

# 数据库原子快照热备份 (VACUUM INTO，不锁表且不影响正在进行的只读读取)
sqlite3 <workspace-root>/enkeep/.demo-data/platform.db \
  "VACUUM INTO '<enkeep-config-dir>/snapshots/platform.db.pre-batch4-vacuum';"
```

### 步骤 3: 负载排空与在途状态核验 (Drain Gate & Quiescence Verification)
在停机前查询 `platform.db`，确保无活跃轮次、排队任务或锁租约：
```sql
SELECT count(*) FROM turn_runs WHERE status = 'running';              -- 必须为 0
SELECT count(*) FROM turn_execution_queue;                            -- 必须为 0
SELECT count(*) FROM task_runs WHERE status IN ('running', 'claimed');-- 必须为 0
SELECT count(*) FROM session_execution_leases WHERE status = 'active';-- 必须为 0
```

### 步骤 4: 人工操作员确认 (Operator Confirmation Gate)
> **安全门禁**: 生产发布必须由人工操作员显式授权。严禁会话内子代理在无外部监督情况下擅自触发自身宿主重启。

### 步骤 5: 优雅停机 (Graceful Shutdown)
定位监听 3900 端口的目标进程并发送优雅退出信号：
```bash
TARGET_PID=$(lsof -ti :3900)
if [ -n "$TARGET_PID" ]; then
  kill -TERM "$TARGET_PID"
  # 等待进程释放端口 (通常 2~5 秒)
fi
```

### 步骤 6: 托管后台作业启动 (Managed Daemon Startup)
以 `enkeep` 为当前工作目录，通过 DSH Harness Managed Job 长期托管运行：
```bash
cd <workspace-root>/enkeep

ENKEEP_RUNTIME_IMAGE=enkeep-runtime:gap-batch4-4de11b1 \
ENKEEP_PIPELINE_MANIFEST=<enkeep-config-dir>/pipeline-task-capabilities.json \
DSH_WEB_URL=http://127.0.0.1:3080 \
DSH_COMPACTION_THRESHOLD_TOKENS=200000 \
node <workspace-root>/reports/hc-vs-enkeep/implementation/release-worktree-batch4/packages/demo-runner/dist/demo-runner.js \
  up \
  --port 3900 \
  --network-mode none \
  --allow-host \
  --repo-root <workspace-root>/enkeep
```

### 步骤 7: 通用非信道健康验证 (Generic Smoke Verification)
严禁调用飞书/微信外部信道，仅执行通用端点与 CLI 冒烟验证：
```bash
# 1. Web 控制台可达性 (HTTP 200)
curl -s -i http://127.0.0.1:3900/ | grep -q "200 OK"

# 2. CSRF 鉴权凭证接口
curl -s http://127.0.0.1:3900/api/auth/csrf | grep -q "csrfToken"

# 3. 本地通用账号登录与空间查询
node reports/hc-vs-enkeep/bench/ek.mjs login
node reports/hc-vs-enkeep/bench/ek.mjs spaces

# 4. 反向代理端口可达性 (HTTP 200)
curl -s -i http://127.0.0.1:3901/ | grep -q "200 OK"
```

### 步骤 8: 快速回滚预案 (Instant Rollback without DB Restore)
若健康验证未通过，执行秒级回滚：
1. 终止异常进程 (`kill -TERM $(lsof -ti :3900)`)；
2. 切回前一稳定版本基线（例如 `release-worktree-batch3` 与 `enkeep-runtime:gap-batch3-47cb9e3`）；
3. 重新执行托管作业启动命令；
4. 数据库结构保持向后兼容（Schema `37`），**无需整库还原 (No DB Restore)**，业务数据 0 丢失。

---

## 4. 交付能力边界与自升级局限说明 (Deliverable Limits)

1. **自主自升级边界 (Autonomous Self-Upgrade NOT Bench-Tested)**:
   - 当前在途会话内的**全自动无人值守热升级（Autonomous In-Turn Self-Upgrade）尚未经过端到端基准压力测试**。
   - 现网已成功验证的机制为“受控流水线 + 隔离工作树构建 + 操作员显式授权 + 托管作业切换”。
2. **外部 Supervisor 要求**:
   - 生产环境建议通过外部独立进程守护器（如 Launchd / Systemd 或 DSH Host Harness Managed Job）监听发布信号并执行进程切换，避免工作进程“自杀式重启”导致会话或信道中断。
