# Enkeep 生产部署与发布流程 (Deployment & Release)

> **唯一入口**：所有上线、平台重启、验证和回滚都通过 `scripts/deploy-release.mjs` 完成。不要手工改 plist、手工 `launchctl` 或手工构建发布；附录中的手工步骤只用于脚本本身出故障时排障。
>
> **核心原则**：只发布已合入 `main` 并通过定向测试的提交；系统不空闲时绝不重启（宁可等待，超时则放弃本次部署）；保留生产数据库与 Docker 数据卷；验证过程不向飞书/微信发送消息。

---

## 1. 拓扑与路径

- **平台服务**：`http://127.0.0.1:<port>`，由 macOS LaunchAgent `<launchd-label>` 托管（PPID 为 1）；反向代理 `http://127.0.0.1:<proxy-port>`。
- **运行时**：每个用户一个运行时，分宿主模式（宿主 daemon 进程）和容器模式（Docker 容器 `<container-prefix>*`，网络 `none`，数据卷 `enkeep-demo-dsh-*`）。
- **其他本地服务**：同机其他服务的端口（例如 DSH Web、HappyClaw）不得停止或干扰。
- **数据目录**：`<data-dir>`（含 `platform.db`）。
- **私有配置目录**：`<enkeep-config-dir>`，其中 `deploy.env` 保存本机部署参数，`snapshots/` 保存数据库快照与 plist 备份。
- **发布工作树**：`<release-root>/release-worktree-<batchId>`，每次发布由脚本创建并检出 `release/<batchId>` 分支。
- **日志**：LaunchAgent 的 stdout/stderr 文件（见 plist 的 `StandardOutPath` / `StandardErrorPath`）。

## 2. 红线

1. **LaunchAgent 是唯一常驻方式**：不得用 DSH 后台任务或 nohup 运行平台。
2. **不空闲不重启**：停机前必须通过 `demo-runner preflight`（平台轮次与队列、定时任务与租约、各运行时的前台/自主轮次、后台 job/workflow、存活子代理、待处理 inbox）。脚本内置该检查并在不空闲时等待。
3. **不得模糊杀进程**（如 `pkill -f node`）；服务启停只经 launchd。
4. **不得删除或覆盖生产数据库**；迁移只做向后兼容的新增；回滚不还原数据库。
5. **不得删除 Docker 数据卷**。
6. **验证不调用飞书/微信发送接口**。
7. **不在代码、文档、提交信息中写入密钥或本机信息**；本机参数只放在 `<enkeep-config-dir>/deploy.env`（仓库内只有占位符版 `deploy.env.example`）。

## 3. 标准流程

### 3.1 配置

复制 `deploy.env.example` 到 `<enkeep-config-dir>/deploy.env` 并填写本机值（权限 600，不进仓库）。缺少必填项时脚本直接报错，不使用任何本机默认值。

可调参数（括号内为默认值）：

| 变量 | 含义 |
|---|---|
| `PREFLIGHT_TIMEOUT_SECONDS`（86400，即 24 小时） | 停机前等待空闲的最长时间；超时则放弃本次部署，不重启 |
| `PREFLIGHT_INTERVAL_SECONDS`（120） | 等待期间的检查间隔 |
| `PREFLIGHT_DUE_MINUTES`（10） | 这么多分钟内将触发的定时任务也视为不空闲 |

### 3.2 发布

```bash
# 先预演：打印改动分类和将执行的步骤，不做任何修改
node scripts/deploy-release.mjs --env-file <enkeep-config-dir>/deploy.env --dry-run

# 正式发布（默认发布 origin/main，按改动范围自动选择方式）
node scripts/deploy-release.mjs --env-file <enkeep-config-dir>/deploy.env \
  --tested-commit <已通过定向测试的提交>
```

脚本对比线上提交与目标提交的改动路径，分为三类，同一次发布按“前端 → 运行时 → 平台”的顺序处理：

| 改动范围 | 处理方式 | 是否需要空闲 |
|---|---|---|
| 仅前端（`packages/web-ui/**`） | 在线上工作树原子替换静态文件（资源带内容哈希），不重启任何进程；用户刷新页面即生效 | 不需要 |
| 运行时（`runtime-runner`、`dsh-*`、`docker/**`、运行时依赖） | 构建镜像，写入目标运行时版本；平台中的 `RuntimeAutoUpgrader` 在每个用户运行时**连续空闲 5 分钟**后逐个停止旧版本，下一次请求以新版本拉起 | 按用户各自空闲，不需要整体空闲 |
| 平台（其余服务端包；无法判定的路径也归此类） | 等待整体空闲后只重启平台进程，**保留运行中的容器和宿主 daemon** | 需要整体空闲 |

测试：目标提交的代码树与 `--tested-commit` 一致时跳过重复测试；不一致时必须用 `--test-cmd`（可重复）或 `TEST_CMDS` 指定定向测试，否则报错。不在部署时跑全量测试。

`--mode full` 是兜底的全量模式（停止并重建全部容器），只在明确需要时使用。

### 3.3 只重启平台（不发布）

用于恢复类操作，例如渠道长连接异常：

```bash
node scripts/deploy-release.mjs --env-file <enkeep-config-dir>/deploy.env --only restart-platform
```

先等待整体空闲（同 3.1 的超时规则），再原地重启当前版本的平台进程，运行时保留，最后执行部署后检查。

### 3.4 验证与回滚

```bash
# 部署后检查（发布和重启时自动执行，也可单独运行，只读）
node scripts/deploy-release.mjs --env-file <enkeep-config-dir>/deploy.env --only verify

# 回滚到最近一次 plist 备份（上一个发布工作树与镜像）
node scripts/deploy-release.mjs --env-file <enkeep-config-dir>/deploy.env --only rollback
```

检查项：CSRF 接口 200；平台与代理端口进程 PPID 为 1 且返回 200；容器全部运行（全量模式下要求为新镜像，分层模式下打印各运行时的升级状态）；平台外部长连接数量与切换前一致；部署后空闲检查通过。

### 3.5 用户级资产单份副本（一次性收敛）

用户级资产（全局 memory、skills、`AGENTS.md`）只有宿主 `host-runtimes/<username>/.dsh/` 一份，容器只读挂载，详见 [user-assets.md](./user-assets.md)。已有卷的容器在收敛前不会启用挂载。首次发布包含该功能后，在用户空闲时执行：

```bash
# 只比较、只报告，不做任何修改
node packages/demo-runner/dist/demo-runner.js user-assets-migrate --data-dir <data-root> --dry-run

# 内容一致的用户：把容器内副本归档到卷内 .enkeep-archive/ 并写收敛标记
node packages/demo-runner/dist/demo-runner.js user-assets-migrate --data-dir <data-root>
```

报告为 `divergent` 的用户不会被修改：先按报告列出的相对路径把需要的内容合入宿主副本后重跑；或确认容器副本可丢弃后加 `--archive-divergent`（仅归档，不覆盖宿主）。收敛后容器在空闲时由自动升级路径重建（卷数据保留），重建后生效。应急关闭：平台进程设 `ENKEEP_USER_ASSET_MOUNTS=0` 并重启平台；仍带挂载的容器在重建前继续经平台写宿主副本，空闲重建后改回卷内副本（启动时清理 Docker 留下的 root 空占位，标记置为 `suspended`），重新开启需对该卷再跑一次 `user-assets-migrate`。详见 `docs/user-assets.md`。

### 3.6 清理旧发布工作树

```bash
node scripts/prune-release-worktrees.mjs --release-root <release-root> --repo-root <repo-root> \
  --keep 3 --active-worktree <线上发布工作树> --dry-run
```

用 `--active-worktree` 保护线上正在使用的工作树；确认预演结果后去掉 `--dry-run` 执行。

---

## 附录：手工排障步骤（不作为常规流程）

仅在部署脚本本身无法工作时使用，操作后应尽快修复脚本。

```bash
# 空闲检查（不空闲时等待；超时非零退出）
node <release-worktree>/packages/demo-runner/dist/demo-runner.js preflight \
  --data-dir <data-dir> --port <port> --due-within-minutes 10 \
  --wait --timeout-seconds 86400 --interval-seconds 120

# 空闲后原地重启平台（与上一条写在同一条命令里，用 && 连接）
launchctl kickstart -k gui/$(id -u)/<launchd-label>

# 健康检查
curl -s http://127.0.0.1:<port>/api/auth/csrf
```

LaunchAgent plist 中与发布相关的字段：`ProgramArguments` 里的发布工作树 `demo-runner.js` 路径，以及 `EnvironmentVariables.ENKEEP_RUNTIME_IMAGE`（运行时镜像的默认值；实际目标版本以平台数据库中的目标运行时版本为准）。其余环境变量（如 `ENKEEP_DSH_HOME`、执行预算、`PTHREAD_MUTEX_USE_ULOCK` 等）随发布保持不变。`PTHREAD_MUTEX_USE_ULOCK=1` 仅用于 macOS，需在进程启动时存在，用于规避 libuv 线程池卡死在 `__psynch_cvwait` 的内核缺陷（见 [libuv#5280](https://github.com/libuv/libuv/issues/5280)）。
