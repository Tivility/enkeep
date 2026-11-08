# Enkeep 生产部署与发布流程 (Deployment & Release)

> **唯一入口**：所有上线、平台重启、验证和回滚都通过 `scripts/deploy-release.mjs` 完成。不要手工改 plist、手工 `launchctl` 或手工构建发布；附录中的手工步骤只用于脚本本身出故障时排障。
>
> **核心原则**：只发布已合入 `main` 并通过定向测试的提交；系统不空闲时绝不重启（宁可等待，超时则放弃本次部署）；保留生产数据库与 Docker 数据卷；验证过程不向飞书/微信发送消息。

---

## 1. 拓扑与路径

- **平台服务**：`http://127.0.0.1:<port>`，由 macOS LaunchAgent `<launchd-label>` 托管（PPID 为 1）；反向代理 `http://127.0.0.1:<proxy-port>`。
- **平台进程**：`node <release-worktree>/packages/enkeep-server/dist/enkeep-server.js serve --data-dir <data-dir> ...`（进程名 `enkeep-server`）。旧部署是 `demo-runner.js up`，用 3.6 迁移。
- **运行时**：每个用户一个运行时，分宿主模式（宿主 daemon 进程）和容器模式（Docker 容器 `enkeep-runtime-<用户>`，网络 `none`，数据卷 `enkeep-home-<用户>`，标签 `app=enkeep`、`enkeep.env=production`）。`enkeep-demo-*` / `enkeep-demo-dsh-*` / `app=enkeep-demo` 只属于测试和演示。
- **其他本地服务**：同机其他服务的端口（例如 DSH Web、HappyClaw）不得停止或干扰。
- **数据目录**：`<data-dir>`（含 `platform.db`），放在任何代码检出之外（例如 `~/.local/share/enkeep/data`），根目录有标记文件 `enkeep-production.json`。带标记的目录会被 `demo-runner reset|up|down|test|bind-lark` 拒绝，只能由 `enkeep-server` 和本脚本操作。
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

部署后检查通过平台的只读自检接口 `GET /api/selfcheck` 读取版本、迁移和健康状态，不需要管理员账号：

- 平台每次启动时（开始监听之前）生成一个新的随机 token，写入 `<data-dir>/selfcheck.token`，权限 600。内存里只保留它的哈希。
- 这个 token 只能访问 `/api/selfcheck`，不能当会话用，也打不开任何管理接口。接口只接受 GET，只服务本机回环连接，返回结果里不含用户 id、用户名、空间、会话或配置。
- 平台前面的反向代理也是从 127.0.0.1 转发请求，所以光看来源地址是 127.0.0.1 不能证明请求来自本机脚本。因此真正的门槛是 token；回环限制只是第二道防线。
- 脚本读 token 前会检查文件：必须是普通文件，不能是符号链接，属主必须是当前用户，权限必须是 600。脚本不打印 token。
- 自检失败一律算验证失败，不会再当成「没有运行时」。失败包括：token 缺失、401/403、404、返回格式不对、迁移未完成、运行时或任务队列不可用。
- `--only runtime` 是唯一的例外。这一步查询的是还在运行的旧平台，如果平台没在监听，或者旧平台还没有这个接口（首次部署这项改动时），脚本给出警告后继续；切换后的验证仍然严格执行。平台在监听但超时不回应，判为失败。
- token 只在平台成功占用端口之后才签发，所以一个因端口冲突起不来的实例不会覆盖正在服务的实例的 token。token 文件写不进去时平台照常启动，只是这个接口返回 404，部署检查会因此报失败。
- 过渡期：对还没有这个接口的平台（首次部署这项改动之前，或回滚到更早的版本之后）单独运行 `--only verify` 或 `--only restart-platform`，会报 not-supported 失败。这是预期行为，不代表平台有问题。

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

### 3.5 迁移旧部署：数据目录搬出仓库、运行时改名

旧部署的数据目录在仓库检出里（`<repo-root>/.demo-data`），容器和卷叫 `enkeep-demo-*`，平台由 `demo-runner up` 启动。一次性迁移：

```bash
# 预演（不改动任何东西）
node scripts/deploy-release.mjs --env-file <enkeep-config-dir>/deploy.env \
  --only migrate-data-dir --new-data-dir <new-data-dir> --dry-run

# 执行：发布目标提交，等整体空闲后停平台，先做独立备份，再迁移并以 enkeep-server serve 启动
node scripts/deploy-release.mjs --env-file <enkeep-config-dir>/deploy.env \
  --only migrate-data-dir --new-data-dir <new-data-dir> \
  --backup-dir <backup-dir> [--before-start "<停机窗口内要执行的命令>"] --test-cmd "<定向测试>"
```

`--backup-dir` 在停机后、任何改动之前，把 `platform.db` 用 SQLite 在线备份写到 `<backup-dir>/platform.db.backup` 并做完整性检查，再把整个数据目录克隆到 `<backup-dir>/data`（APFS 上为写时复制克隆）。`--before-start` 在迁移完成后、平台重新启动前执行，用于同一停机窗口内的其他操作，例如重启 Docker 虚拟机使新的内存上限生效。卷的复制按内容校验：逐个文件比对路径、类型与权限、属主、大小、符号链接目标和内容 md5。

切换时 `enkeep-server migrate-data-dir` 依次执行：

1. 给旧目录写入生产标记。
2. 把每个 `enkeep-demo-dsh-<id>` 卷复制到新卷 `enkeep-home-<id>`，并按文件列表和大小校验。旧卷原样保留作备份，不删除。
3. 全部校验通过后才开始切换：删除旧容器（数据在卷里），签发新卷元数据，旧元数据移到 `volumes-retired/`、`containers-retired/`。
4. 同一文件系统内重命名目录，并在旧路径留一个指向新目录的符号链接，这样旧会话里记录的绝对路径仍然有效。

之后 plist 改为 `enkeep-server serve --data-dir <new-data-dir>`，平台启动时以新名字重建容器。完成后把 deploy env 的 `DATA_DIR` 改为 `<new-data-dir>`。

迁移开始复制前会先停掉旧的运行时容器（数据都在卷里，容器根文件系统只读），保证复制期间没有写入；宿主 daemon 或平台进程仍在运行时直接拒绝。

还原（`--revert`）后旧版本使用迁移前的 `enkeep-demo-dsh-*` 卷：迁移后容器用户新写入的内容只在 `enkeep-home-*` 卷里，如需保留要手工拷回；宿主模式的数据在数据目录里，随目录一起还原。

旧的 `enkeep-demo-dsh-*` 卷是回滚用的备份，至少保留到确认新部署稳定（建议 7 天）后再手工删除。它们没有 `enkeep.env=test` 标签，`demo-runner reap` 不会碰。

切换中途出错时，脚本会自动还原迁移和 plist。部署后检查失败时脚本会打印还原命令；迁移之后**不要单独用 `--only rollback`**，因为旧版本要求数据目录在原路径：

```bash
launchctl bootout gui/$(id -u) <plist-path>
node <release-worktree>/packages/enkeep-server/dist/enkeep-server.js migrate-data-dir --revert --from <old-data-dir> --to <new-data-dir>
cp <迁移前的 plist 备份> <plist-path> && launchctl bootstrap gui/$(id -u) <plist-path>
```

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
node <release-worktree>/packages/enkeep-server/dist/enkeep-server.js preflight \
  --data-dir <data-dir> --port <port> --due-within-minutes 10 \
  --wait --timeout-seconds 86400 --interval-seconds 120

# 空闲后原地重启平台（与上一条写在同一条命令里，用 && 连接）
launchctl kickstart -k gui/$(id -u)/<launchd-label>

# 健康检查
curl -s http://127.0.0.1:<port>/api/auth/csrf
```

LaunchAgent plist 中与发布相关的字段：`ProgramArguments` 里的发布工作树入口路径（`enkeep-server.js`，旧部署为 `demo-runner.js`），以及 `EnvironmentVariables.ENKEEP_RUNTIME_IMAGE`（运行时镜像的默认值；实际目标版本以平台数据库中的目标运行时版本为准）。`enkeep-server serve` 部署每次发布还会把 `ProgramArguments` 里的 `--repo-root` 和顶层的 `WorkingDirectory` 改成 `<release-worktree>`（plist 没有 `WorkingDirectory` 时补上），让服务只引用它正在运行的发布工作树；旧的 `demo-runner up` 部署靠这两项定位 `<repo-root>/.demo-data`，所以保持不变。回滚恢复整份 plist 备份，这两项一并还原。其余环境变量（如 `ENKEEP_DSH_HOME`、执行预算、`PTHREAD_MUTEX_USE_ULOCK` 等）随发布保持不变。`PTHREAD_MUTEX_USE_ULOCK=1` 仅用于 macOS，需在进程启动时存在，用于规避 libuv 线程池卡死在 `__psynch_cvwait` 的内核缺陷（见 [libuv#5280](https://github.com/libuv/libuv/issues/5280)）。
