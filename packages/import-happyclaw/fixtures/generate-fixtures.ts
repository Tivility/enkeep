/**
 * Deterministic generator for mock HappyClaw fixtures.
 *
 * Generates:
 * 1. Minimal SQLite messages.db with chats, messages, and registered_groups.
 *    - Alice (25+ dialogue turns, consecutive user messages, consecutive assistant messages,
 *      empty messages, missing/illegal timestamps, attachments).
 *    - Bob (former-host execution mode, migration conversation, attachments).
 * 2. Group space files for Alice and Bob:
 *    - CLAUDE.md
 *    - notes/
 *    - conversations/
 *    - artifacts/ (sample output / 示例产物)
 * 3. Pure mock synthetic data — strictly zero real Feishu / WeChat data.
 */

import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'

const FIXTURES_ROOT = dirname(fileURLToPath(import.meta.url))
const SOURCE_DIR = join(FIXTURES_ROOT, 'source')
const DB_DIR = join(SOURCE_DIR, 'db')
const GROUPS_DIR = join(SOURCE_DIR, 'groups')
const DB_PATH = join(DB_DIR, 'messages.db')

export function generateFixtures(targetSourceDir: string = SOURCE_DIR): {
  sourceDir: string
  dbPath: string
  groupsDir: string
} {
  const dbDir = join(targetSourceDir, 'db')
  const groupsDir = join(targetSourceDir, 'groups')
  const dbPath = join(dbDir, 'messages.db')

  // Clean existing
  rmSync(targetSourceDir, { recursive: true, force: true })
  mkdirSync(dbDir, { recursive: true })
  mkdirSync(groupsDir, { recursive: true })

  // 1. Generate Spaces
  generateAliceSpace(groupsDir)
  generateBobSpace(groupsDir)

  // 2. Generate SQLite messages.db
  generateSqliteDb(dbPath)

  return {
    sourceDir: targetSourceDir,
    dbPath,
    groupsDir,
  }
}

function generateAliceSpace(groupsDir: string): void {
  const aliceDir = join(groupsDir, 'alice-space')
  mkdirSync(aliceDir, { recursive: true })
  mkdirSync(join(aliceDir, 'notes'), { recursive: true })
  mkdirSync(join(aliceDir, 'conversations'), { recursive: true })
  mkdirSync(join(aliceDir, 'artifacts'), { recursive: true })

  writeFileSync(
    join(aliceDir, 'CLAUDE.md'),
    `# Alice Space Assistant Guidelines

You are an AI assistant helping Alice develop the NextGen Analytics engine.
Follow clean architecture, write unit tests for each module, and adhere to TypeScript strict mode.
`,
    'utf8'
  )

  writeFileSync(
    join(aliceDir, 'notes', 'project-plan.md'),
    `# Project Architecture Plan

## 1. Overview
NextGen Analytics Engine is designed for high-throughput event processing.

## 2. Core Components
- Ingestion Gateway
- Event Sourcing Store
- Real-time Aggregator
- Query API
`,
    'utf8'
  )

  writeFileSync(
    join(aliceDir, 'conversations', 'topics.md'),
    `# Discussion Topics

- Distributed tracing & telemetry
- Schema evolution & migration strategies
- Memory efficiency during large batch replay
`,
    'utf8'
  )

  writeFileSync(
    join(aliceDir, 'artifacts', 'summary.json'),
    JSON.stringify(
      {
        project: 'NextGen Analytics',
        owner: 'Alice',
        status: 'in-progress',
        milestones: [
          { phase: 'P0', title: 'Architecture Review', done: true },
          { phase: 'P1', title: 'Event Sourcing Core', done: false },
        ],
      },
      undefined,
      2
    ) + '\n',
    'utf8'
  )
}

function generateBobSpace(groupsDir: string): void {
  const bobDir = join(groupsDir, 'bob-space')
  mkdirSync(bobDir, { recursive: true })
  mkdirSync(join(bobDir, 'notes'), { recursive: true })
  mkdirSync(join(bobDir, 'conversations'), { recursive: true })
  mkdirSync(join(bobDir, 'artifacts'), { recursive: true })

  writeFileSync(
    join(bobDir, 'CLAUDE.md'),
    `# Bob Space Former-Host Workspace

This workspace contains legacy project archives imported from the former host.
Maintain data integrity and keep historical context preserved.
`,
    'utf8'
  )

  writeFileSync(
    join(bobDir, 'notes', 'migration-notes.md'),
    `# Former-Host Migration Notes

- Host ID: legacy-node-042
- Migration Protocol: v2-snapshot
- All former host state has been sanitized and staged for DSH-Claw integration.
`,
    'utf8'
  )

  writeFileSync(
    join(bobDir, 'conversations', 'former-host-context.md'),
    `# Former Host Operational Context

Historical configurations and operational logs from former host deployment.
`,
    'utf8'
  )

  writeFileSync(
    join(bobDir, 'artifacts', 'legacy-report.txt'),
    `Former-Host System Health Report
Node: legacy-node-042
Exported: 2026-08-01T00:00:00Z
Status: Decommissioned and migrated.
`,
    'utf8'
  )
}

function generateSqliteDb(dbPath: string): void {
  const db = new DatabaseSync(dbPath)

  db.exec(`
    CREATE TABLE chats (
      jid TEXT PRIMARY KEY,
      name TEXT
    );

    CREATE TABLE registered_groups (
      jid TEXT PRIMARY KEY,
      name TEXT,
      folder TEXT,
      execution_mode TEXT
    );

    CREATE TABLE messages (
      id TEXT PRIMARY KEY,
      chat_jid TEXT,
      content TEXT,
      timestamp TEXT,
      is_from_me INTEGER,
      attachments TEXT
    );
  `)

  // Insert chats
  const insertChat = db.prepare('INSERT INTO chats (jid, name) VALUES (?, ?)')
  insertChat.run('web:alice-workspace-jid-001', 'Alice Project Space')
  insertChat.run('web:bob-migration-jid-002', 'Bob Former Host Space')

  // Insert registered_groups
  const insertGroup = db.prepare(
    'INSERT INTO registered_groups (jid, name, folder, execution_mode) VALUES (?, ?, ?, ?)'
  )
  insertGroup.run('web:alice-workspace-jid-001', 'Alice Project Space', 'alice-space', 'default')
  insertGroup.run('web:bob-migration-jid-002', 'Bob Former Host Space', 'bob-space', 'former-host')

  // Prepare insert message
  const insertMessage = db.prepare(
    'INSERT INTO messages (id, chat_jid, content, timestamp, is_from_me, attachments) VALUES (?, ?, ?, ?, ?, ?)'
  )

  const aliceJid = 'web:alice-workspace-jid-001'
  const bobJid = 'web:bob-migration-jid-002'

  // Alice Conversation: 25+ human turns, edge cases:
  // - Consecutive user messages
  // - Consecutive assistant messages
  // - Empty messages (content null / empty string)
  // - Missing timestamp (null / empty)
  // - Invalid timestamp ("invalid-time", "abc")
  // - Attachments with relative paths

  const aliceMessages: Array<{
    id: string
    content: string | null
    timestamp: string | null
    is_from_me: number
    attachments: string | null
  }> = [
    // Turn 1
    { id: 'm-001', content: '你好，我们开始讨论新项目的架构设计吧。', timestamp: '2026-08-01T08:00:00.000Z', is_from_me: 0, attachments: null },
    { id: 'm-002', content: '你好 Alice！很高兴和你合作。请问这个系统的主要业务场景与吞吐量预期是什么？', timestamp: '2026-08-01T08:00:05.000Z', is_from_me: 1, attachments: null },

    // Turn 2
    { id: 'm-003', content: '我们需要支持每秒10000个事件的实时摄取，并且要求高可用。', timestamp: '2026-08-01T08:01:00.000Z', is_from_me: 0, attachments: null },
    { id: 'm-004', content: '收到。10k QPS 下建议采用分区事件总线 + 内存聚合缓冲，配合 WAL 保证持久性。', timestamp: '2026-08-01T08:01:10.000Z', is_from_me: 1, attachments: null },

    // Turn 3
    { id: 'm-005', content: '存储选型你有什么建议？是否适合用 SQLite 做本地缓存？', timestamp: '2026-08-01T08:02:00.000Z', is_from_me: 0, attachments: null },
    { id: 'm-006', content: 'SQLite 在 WAL 模式下非常适合单节点高性能写入，但跨进程并发需要做好锁管理。', timestamp: '2026-08-01T08:02:15.000Z', is_from_me: 1, attachments: null },

    // Turn 4 - Attachment reference
    { id: 'm-007', content: '我整理了一份架构大纲，你过目一下。', timestamp: '2026-08-01T08:03:00.000Z', is_from_me: 0, attachments: JSON.stringify([{ path: 'notes/project-plan.md' }]) },
    { id: 'm-008', content: '已经查看了 project-plan.md。整体四个核心组件分工明确，设计合理。', timestamp: '2026-08-01T08:03:20.000Z', is_from_me: 1, attachments: null },

    // Turn 5 - Consecutive User Messages
    { id: 'm-009', content: '对了，我们在事件定义上必须采用严格的 Schema 校验。', timestamp: '2026-08-01T08:04:00.000Z', is_from_me: 0, attachments: null },
    { id: 'm-010', content: '另外还要支持向后兼容的版本演进。', timestamp: '2026-08-01T08:04:10.000Z', is_from_me: 0, attachments: null },
    { id: 'm-011', content: '明白，推荐在事件信封中引入 schemaVersion 和 discriminators，配合只增不减策略保证兼容。', timestamp: '2026-08-01T08:04:30.000Z', is_from_me: 1, attachments: null },

    // Turn 6 - Consecutive Assistant Messages
    { id: 'm-012', content: '请帮我写一个事件信封的 TypeScript 接口草案。', timestamp: '2026-08-01T08:05:00.000Z', is_from_me: 0, attachments: null },
    { id: 'm-013', content: '这是事件信封的接口：\n```ts\nexport interface DomainEvent<T> {\n  id: string;\n  type: string;\n  version: number;\n  timestamp: number;\n  payload: T;\n}\n```', timestamp: '2026-08-01T08:05:15.000Z', is_from_me: 1, attachments: null },
    { id: 'm-014', content: '补充说明：我们可以通过 branded types 对 id 和 type 进行强类型收窄。', timestamp: '2026-08-01T08:05:20.000Z', is_from_me: 1, attachments: null },

    // Turn 7 - Missing Timestamp (null)
    { id: 'm-015', content: 'Branded types 这个主意不错，具体怎么定义？', timestamp: null, is_from_me: 0, attachments: null },
    { id: 'm-016', content: '可以通过声明独一无二的 symbol 属性来实现零运行时开销的编译期名义类型检查。', timestamp: '2026-08-01T08:06:00.000Z', is_from_me: 1, attachments: null },

    // Turn 8 - Empty messages (should be dropped)
    { id: 'm-017', content: '', timestamp: '2026-08-01T08:06:30.000Z', is_from_me: 0, attachments: null },
    { id: 'm-018', content: '   ', timestamp: '2026-08-01T08:06:35.000Z', is_from_me: 1, attachments: null },
    { id: 'm-019', content: '那么关于快照机制，我们多久打一次快照合适？', timestamp: '2026-08-01T08:07:00.000Z', is_from_me: 0, attachments: null },
    { id: 'm-020', content: '建议根据事件数量（例如每1000条）或时间间隔（例如每5分钟）双触发。', timestamp: '2026-08-01T08:07:15.000Z', is_from_me: 1, attachments: null },

    // Turn 9 - Invalid Timestamp ("invalid-date")
    { id: 'm-021', content: '快照如果损坏，恢复流程是怎样的？', timestamp: 'not-a-valid-timestamp', is_from_me: 0, attachments: null },
    { id: 'm-022', content: '快照应附带校验和。若校验失败，自动回退到上一个有效快照并重放后续事件。', timestamp: '2026-08-01T08:08:00.000Z', is_from_me: 1, attachments: null },

    // Turn 10
    { id: 'm-023', content: '非常好，我们把这个逻辑整理进讨论议题。', timestamp: '2026-08-01T08:09:00.000Z', is_from_me: 0, attachments: JSON.stringify([{ name: 'conversations/topics.md' }]) },
    { id: 'm-024', content: '已在 topics.md 中记录重放恢复与快照校验策略。', timestamp: '2026-08-01T08:09:20.000Z', is_from_me: 1, attachments: null },

    // Turn 11
    { id: 'm-025', content: '服务如何处理优雅关机与信号捕获？', timestamp: '2026-08-01T08:10:00.000Z', is_from_me: 0, attachments: null },
    { id: 'm-026', content: '监听 SIGTERM 和 SIGINT，停止接收新连接，刷盘未持久化事件，最后释放资源。', timestamp: '2026-08-01T08:10:15.000Z', is_from_me: 1, attachments: null },

    // Turn 12
    { id: 'm-027', content: '单元测试框架用什么？Vitest 还是 Jest？', timestamp: '2026-08-01T08:11:00.000Z', is_from_me: 0, attachments: null },
    { id: 'm-028', content: '推荐 Vitest，原生支持 ESM 和 TypeScript，执行速度更快且配置更简洁。', timestamp: '2026-08-01T08:11:10.000Z', is_from_me: 1, attachments: null },

    // Turn 13
    { id: 'm-029', content: '测试用例的覆盖率指标定多少合适？', timestamp: '2026-08-01T08:12:00.000Z', is_from_me: 0, attachments: null },
    { id: 'm-030', content: '核心领域模型和存储层建议做到 100% 分支覆盖率，边界条件全面覆盖。', timestamp: '2026-08-01T08:12:12.000Z', is_from_me: 1, attachments: null },

    // Turn 14
    { id: 'm-031', content: '关于错误处理，我们是抛出异常还是返回 Result 对象？', timestamp: '2026-08-01T08:13:00.000Z', is_from_me: 0, attachments: null },
    { id: 'm-032', content: '预期内的业务失败建议用带有错误码的 Result 类型，不可预期的系统故障再抛异常。', timestamp: '2026-08-01T08:13:20.000Z', is_from_me: 1, attachments: null },

    // Turn 15
    { id: 'm-033', content: '产物总结报告存放在哪里？', timestamp: '2026-08-01T08:14:00.000Z', is_from_me: 0, attachments: JSON.stringify([{ filename: 'artifacts/summary.json' }]) },
    { id: 'm-034', content: '已经产出了 summary.json 包含阶段里程碑和状态跟踪。', timestamp: '2026-08-01T08:14:15.000Z', is_from_me: 1, attachments: null },

    // Turn 16
    { id: 'm-035', content: '对于并发写入冲突，我们用乐观锁还是悲观锁？', timestamp: '2026-08-01T08:15:00.000Z', is_from_me: 0, attachments: null },
    { id: 'm-036', content: '事件溯源天然适合基于 version 序列号的乐观并发控制（OCC）。', timestamp: '2026-08-01T08:15:15.000Z', is_from_me: 1, attachments: null },

    // Turn 17
    { id: 'm-037', content: '如果发生版本冲突，重试策略如何设计？', timestamp: '2026-08-01T08:16:00.000Z', is_from_me: 0, attachments: null },
    { id: 'm-038', content: '重新拉取最新事件流，重新应用命令，如果业务不冲突则重试提交，并配合指数退避。', timestamp: '2026-08-01T08:16:25.000Z', is_from_me: 1, attachments: null },

    // Turn 18
    { id: 'm-039', content: '日志级别我们如何规划？', timestamp: '2026-08-01T08:17:00.000Z', is_from_me: 0, attachments: null },
    { id: 'm-040', content: '生产环境默认 INFO，安全审计与状态变更打 INFO，性能采样打 DEBUG，错误带上下文打 ERROR。', timestamp: '2026-08-01T08:17:15.000Z', is_from_me: 1, attachments: null },

    // Turn 19
    { id: 'm-041', content: '我们还需要考虑配置文件的热重载机制。', timestamp: '2026-08-01T08:18:00.000Z', is_from_me: 0, attachments: null },
    { id: 'm-042', content: '可以通过文件 watcher 监听配置变化，校验无误后原子切换配置上下文。', timestamp: '2026-08-01T08:18:18.000Z', is_from_me: 1, attachments: null },

    // Turn 20
    { id: 'm-043', content: '关于跨时区时间戳，统一使用 UTC 格式还是 Epoch 毫秒？', timestamp: '2026-08-01T08:19:00.000Z', is_from_me: 0, attachments: null },
    { id: 'm-044', content: '存储和计算统一使用 Epoch 毫秒整数，展示和日志使用 ISO 8601 UTC 字符串。', timestamp: '2026-08-01T08:19:15.000Z', is_from_me: 1, attachments: null },

    // Turn 21
    { id: 'm-045', content: '性能基准测试的指标有哪些？', timestamp: '2026-08-01T08:20:00.000Z', is_from_me: 0, attachments: null },
    { id: 'm-046', content: '重点监控 P95/P99 延迟、GC 暂停时间、事件摄取吞吐量与内存占用峰值。', timestamp: '2026-08-01T08:20:20.000Z', is_from_me: 1, attachments: null },

    // Turn 22
    { id: 'm-047', content: '很好，第一阶段的架构方案已经很清晰了。', timestamp: '2026-08-01T08:21:00.000Z', is_from_me: 0, attachments: null },
    { id: 'm-048', content: '太棒了！接下来我们可以进入代码实现和自动化测试编写阶段。', timestamp: '2026-08-01T08:21:10.000Z', is_from_me: 1, attachments: null },
  ]

  for (const msg of aliceMessages) {
    insertMessage.run(msg.id, aliceJid, msg.content, msg.timestamp, msg.is_from_me, msg.attachments)
  }

  // Bob Conversation: Former host migration
  const bobMessages: Array<{
    id: string
    content: string | null
    timestamp: string | null
    is_from_me: number
    attachments: string | null
  }> = [
    {
      id: 'bob-001',
      content: '请协助分析从 former-host 迁出的遗留服务状态。',
      timestamp: '2026-08-01T09:00:00.000Z',
      is_from_me: 0,
      attachments: JSON.stringify([{ path: 'notes/migration-notes.md' }]),
    },
    {
      id: 'bob-002',
      content: '已加载 migration-notes.md。原节点 legacy-node-042 的快照已校验完成，数据一致性正常。',
      timestamp: '2026-08-01T09:00:20.000Z',
      is_from_me: 1,
      attachments: null,
    },
    {
      id: 'bob-003',
      content: '检查 former-host 产物报告是否完整。',
      timestamp: '2026-08-01T09:01:00.000Z',
      is_from_me: 0,
      attachments: JSON.stringify([{ path: 'artifacts/legacy-report.txt' }]),
    },
    {
      id: 'bob-004',
      content: '产物报告确认完毕，节点状态已安全下线，可以完成归档。',
      timestamp: '2026-08-01T09:01:30.000Z',
      is_from_me: 1,
      attachments: null,
    },
  ]

  for (const msg of bobMessages) {
    insertMessage.run(msg.id, bobJid, msg.content, msg.timestamp, msg.is_from_me, msg.attachments)
  }

  db.close()
}

// If executed directly, generate fixtures in place
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  generateFixtures()
  console.log('Deterministic mock fixtures generated successfully at:', SOURCE_DIR)
}
