# Enkeep 企业级数据备份与恢复指南 (Backup & Restore Architecture)

本文档详细说明 Enkeep 平台生产级备份与灾备恢复工具链（`@enkeep/backup-restore`）的设计架构、安全边界、Quiesce 冻结协议与 CLI 运维命令。

---

## 1. 架构总览与核心设计原则

Enkeep 采用 **SQLite (`platform.db`) 控制面元数据** 与 **DSH Session JSONL / Docker持久卷数据面** 的双存储架构。为保障企业生产级灾备一致性，`@enkeep/backup-restore` 遵循以下核心安全原则：

1. **源平台绝对一致快照与严格零回退 (Strict Zero-Fallback Snapshot & Quiesce)**：
   - 严禁对活跃写入中的数据库或容器卷直接执行冷文件拷贝。`create.ts` 中针对 SQLite `platform.db` 仅使用 `node:sqlite` 的 `VACUUM INTO` 命令创建原子独立快照。
   - **严格零回退保证**：若 `VACUUM INTO` 发生任何异常（如数据库锁死、文件系统只读、目标冲突等），系统立即安全关闭连接并抛出 `BackupRestoreSafetyError` 失败，**绝不回退至 `copyFileSync` 盲拷**，彻底杜绝 WAL 模式下产生脏数据与残损备份的风险。
   - 采用 `readOnly: false` 打开连接，这是因为 SQLite 引擎执行 `VACUUM INTO` 输出外部文件需要写权限句柄，但源数据库页面保持纯只读，绝不发生物理写变更。
   - 快照生成后立即在独立沙箱执行 `PRAGMA integrity_check` 与 `PRAGMA foreign_key_check`，并验证快照已完成 Checkpoint，绝无对 `-wal` / `-shm` 临时文件的残留依赖。
   - 具备 **Quiesce 状态机检测与 FreezeHooks 扩展协议**，检测活跃后台服务/容器 PID，未显式确认（`--demo-stop-confirmed` 或 FreezeHook 回调）拒绝生成脏备份。
2. **强制全量端到端加密 (Authenticated Encryption at Rest)**：
   - 备份包含 `secrets.json`（Cookie HMAC Secret、Meta Token）及用户鉴权哈希等高密数据。
   - 默认强制采用 **AES-256-GCM + scrypt KDF** 强加密，密文头部附带 16 字节 GCM 认证标签（Auth Tag）与随机 Salt/IV。
   - 密钥口令仅允许通过 `--passphrase-file <path>` 本地受控文件读取，严禁通过命令行参数或环境变量暴露（防进程表与历史记录泄露）。
   - 默认禁止创建明文备份（除非显式指定 `--allow-insecure-unencrypted`）。
3. **自研安全 Tar 封包与路径逃逸防御 (Pure-TS POSIX Tar & Path Confinement)**：
   - 严禁调用宿主机系统 `tar` 命令，杜绝 Shell 注入与平台差异。
   - 严格进行 Unicode NFC 规范化与相对 POSIX 路径检查，绝对禁止 `..` 路径穿越、绝对路径、驱动器符与控制字符。
   - **符号链接与特殊文件守卫**：默认严格拒绝所有符号链接（Symlink）、硬链接（Hardlink `nlink > 1`）、命名管道（FIFO）与设备节点，防范解包重定向逃逸。
   - 严格限制单文件上限（默认 1 GiB）、总解压体积上限（默认 10 GiB，防御 ZipBomb）与最大文件数（默认 100,000）。
4. **两阶段原子恢复、类型化投影对账与 Dry-Run 校验**：
   - 恢复过程**绝不原地覆盖**既有数据目录。
   - 所有解包与后置校验在独立同级临时暂存区（Staging Directory）执行，校验通过后通过 `renameSync` 进行原子提交。
   - 任何校验失败或异常自动擦除暂存区，目标目录保持完全无损。
   - **双存储深度对账 (Typed Projection Reconciliation)**：恢复后不仅验证 JSON 语法，更调用类型化 DSH Parser 提取完整对话投影（User / Assistant 序列、Role 与 Text Content），逐条与 SQLite `web_messages` 记录比对，确保数据面与控制面 100% 一致。
   - 支持 `--dry-run` 零写模拟校验，在内存/临时沙箱完成解包、哈希复算、SQLite Integrity Check、Foreign Key Check 与 DSH JSONL 投影解析。
   - 恢复后权限强制收敛（目录 `0o700`，敏感数据文件 `0o600`）。

---

## 2. CLI 命令行运维手册

平台在根目录和独立包提供两套无缝 CLI 命令：`enkeep-backup` 和 `enkeep-restore`。

### 2.1 创建备份 (`create`)

```bash
# 1. 准备高熵密钥文件 (必须 >= 8 字符，建议 0o600 权限)
echo "YourStrongEnterprisePassphrase2026!" > /tmp/backup.pass
chmod 600 /tmp/backup.pass

# 2. 执行加密备份创建
pnpm run backup:create -- \
  --data-root /var/lib/enkeep/data \
  --output /var/backups/enkeep/enkeep-20260828.tar.enc \
  --passphrase-file /tmp/backup.pass \
  --demo-stop-confirmed \
  --description "Daily Production Snapshot"

# 或者使用统一 CLI
pnpm run backup create \
  --data-root /var/lib/enkeep/data \
  --output /var/backups/enkeep/enkeep-20260828.tar.enc \
  --passphrase-file /tmp/backup.pass \
  --demo-stop-confirmed
```

**参数说明**：
- `--data-root <path>`：源数据目录绝对路径（必需）。
- `--output, -o <path>`：输出归档文件绝对路径（必需，严禁位于 `--data-root` 内部）。
- `--passphrase-file, -p <path>`：加密口令文件路径。
- `--demo-stop-confirmed`：显式确认后台容器和平台服务已处于静默/停止状态。
- `--allow-insecure-unencrypted`：显式声明生成未加密备份（不推荐，仅限离线隔离调试）。
- `--description <text>`：记录在清单中的自定义备注。
- `--force, -f`：若输出归档已存在，允许覆盖写入。
- `--json`：以 JSON 格式输出结果。

---

### 2.2 审查归档清单 (`inspect`)

在不释放全量文件的情况下，快速解密并展示备份元数据、文件清单、SQLite 统计与 DSH 会话概览：

```bash
pnpm run backup:inspect -- \
  --archive /var/backups/enkeep/enkeep-20260828.tar.enc \
  --passphrase-file /tmp/backup.pass
```

输出示例：
```text
📦 Enkeep Backup Archive Information
─────────────────────────────────────────────────────────────────
Format Version:          v1
Created At:              2026-08-28T20:28:54.217Z
Enkeep Version:          0.1.0
Runtime Image:           enkeep-demo-runtime:acceptance
Platform Schema Version: v13
Encrypted:               Yes (aes-256-gcm + scrypt)
Has Secrets:             Yes (secrets.json included)
Archive Compressed Size: 1.25 MiB (1,310,720 bytes)
Total Uncompressed Size: 3.42 MiB (3,586,048 bytes)
Total Files:             14

🗄️  SQLite Database Summary:
  Integrity Status:      ok
  Users:                 2
  Spaces:                2
  Sessions:              2
  Messages:              52
  Tables:                users, spaces, session_routes, web_messages, web_events, _schema_migrations
  Applied Migrations:    13 migrations

🧠 DSH Session JSONL Inventory:
  Total Sessions:        2
  - [alice] sessions/sp_alice/sess_alice_1/session.jsonl (42 lines, valid JSONL: true)
  - [bob] sessions/sp_bob/sess_bob_1/session.jsonl (10 lines, valid JSONL: true)

Description:             Daily Production Snapshot
─────────────────────────────────────────────────────────────────
```

---

### 2.3 独立校验归档 (`verify`)

在隔离临时环境中，全量解密、复算每个文件的 SHA-256 哈希与字节大小，并对 SQLite 执行 `PRAGMA integrity_check` 与 `PRAGMA foreign_key_check`，严禁损坏归档：

```bash
pnpm run backup:verify -- \
  --archive /var/backups/enkeep/enkeep-20260828.tar.enc \
  --passphrase-file /tmp/backup.pass
```

---

### 2.4 数据灾备恢复 (`restore`)

#### 步骤一：只读模拟（Dry-Run 零写）
```bash
pnpm run backup:restore -- \
  --archive /var/backups/enkeep/enkeep-20260828.tar.enc \
  --target-root /var/lib/enkeep/data-restored \
  --passphrase-file /tmp/backup.pass \
  --dry-run
```

#### 步骤二：正式恢复与原子提交
```bash
pnpm run backup:restore -- \
  --archive /var/backups/enkeep/enkeep-20260828.tar.enc \
  --target-root /var/lib/enkeep/data \
  --passphrase-file /tmp/backup.pass
```

或者使用专用 restore 二进制：
```bash
pnpm run restore -- \
  --archive /var/backups/enkeep/enkeep-20260828.tar.enc \
  --target-root /var/lib/enkeep/data \
  --passphrase-file /tmp/backup.pass
```

**恢复关键保护机制**：
- **目标目录非空保护**：若 `--target-root` 存在且非空，默认拒绝执行，防止误抹写生产数据；若确需重置，可附加 `--force`。
- **镜像版本匹配保护**：归档记录了创建时的 `runtimeImage`。若恢复环境镜像发生漂移，默认拒绝恢复；确认兼容后可附加 `--allow-runtime-image-mismatch`。
- **后置自动校验**：恢复完成后自动执行 Migration Checksums 比对、SQLite Foreign Keys 检查、DSH JSONL 语法解析与双存储深度投影对账。

---

## 3. 归档清单 Schema (Manifest Specification)

归档内 `backup-manifest.json` 结构定义如下：

```json
{
  "formatVersion": 1,
  "createdAt": "2026-08-28T20:28:54.217Z",
  "enkeepVersion": "0.1.0",
  "runtimeImage": "enkeep-demo-runtime:acceptance",
  "platformSchemaVersion": 13,
  "migrationChecksums": {
    "001": "2d8f...",
    "002": "5c1a...",
    "013": "8e3b..."
  },
  "sqliteIntegrity": {
    "status": "ok",
    "tables": ["users", "spaces", "session_routes", "web_messages", "web_events", "quota_limits", "quota_usage", "platform_tasks", "file_metadata"],
    "userCount": 2,
    "spaceCount": 2,
    "sessionCount": 2,
    "messageCount": 52
  },
  "dshInventory": [
    {
      "userId": "alice",
      "sessionId": "sess_alice_1",
      "dshSessionId": "dsh_sess_alice_1",
      "relativePath": "sessions/sp_alice/sess_alice_1/session.jsonl",
      "lineCount": 42,
      "sha256": "4b2c...",
      "size": 12480,
      "validJsonl": true
    }
  ],
  "files": [
    {
      "path": "platform.db",
      "size": 65536,
      "sha256": "9a1f...",
      "mode": 384
    },
    {
      "path": "secrets.json",
      "size": 256,
      "sha256": "1c8e...",
      "mode": 384
    }
  ],
  "limits": {
    "maxFileSize": 1073741824,
    "maxTotalSize": 10737418240,
    "maxFileCount": 100000
  },
  "summary": {
    "totalFiles": 14,
    "totalBytes": 3586048,
    "hasSecrets": true,
    "encrypted": true,
    "kdf": "scrypt",
    "cipher": "aes-256-gcm"
  },
  "description": "Daily Production Snapshot"
}
```

---

## 4. 自动化测试与质量保障矩阵

`@enkeep/backup-restore` 包含 9 个专项测试套件、55 项全量自动化测试（100% 通过）：

| 测试套件 | 验证范围 |
| :--- | :--- |
| `tests/crypto.test.ts` | scrypt 密钥派生、AES-256-GCM 加解密闭环、口令文件安全检查、口令错误拦截、密文篡改拦截、Auth Tag 校验。 |
| `tests/tar.test.ts` | POSIX ustar / GNU LongLink 编解码、路径穿越拦截（`..`、`/`、控制字符）、硬链接/符号链接拦截、重复路径与大小写碰撞拦截、体积超限拦截。 |
| `tests/quiesce.test.ts` | 活跃进程与 PID 探测、未确认静默拦截、FreezeHooks 声明周期调用与异常 abort 保护。 |
| `tests/manifest.test.ts` | SQLite 元数据解析、完整性检查、DSH JSONL 统计解析、清单校验器。 |
| `tests/vacuum-safety.test.ts` | SQLite `VACUUM INTO` 锁故障注入、零回退断言（绝不产生脏 copy）、`-wal`/`-shm` 无依赖性断言。 |
| `tests/dsh-parser-and-reconcile.test.ts` | 类型化 DSH JSONL 解析器、User/Assistant 消息投影提取、SQLite `web_messages` vs JSONL 角色与内容深度漂移拦截。 |
| `tests/backup-restore-e2e.test.ts` | 完整业务闭环（Create -> Inspect -> Verify -> Dry-run -> Restore）、恢复后 SQLite 登录凭据与消息一致性校验、JSONL 逐字节比对。 |
| `tests/security-confinement.test.ts` | 源目录零修改断言、恶意遍历归档拦截、损坏 SQLite 拦截、外键冲突拦截、损坏 JSONL 拦截、镜像版本漂移拦截、中途失败 Staging 清理保护。 |
| `tests/cli.test.ts` | `enkeep-backup` / `enkeep-restore` 命令行参数解析、JSON 输出格式与退出码断言。 |

运行全量测试命令：
```bash
pnpm --filter @enkeep/backup-restore run test
```
