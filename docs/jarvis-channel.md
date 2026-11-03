# Jarvis 渠道：设计方案（草案）

> 状态：已实现，各项决定见 §7「已定」。本文只用占位符（`<port>`、`<data-dir>`、`<token-file>` 等），不含任何真实部署值。

## 1. 目标

把 Jarvis 当成 enkeep 的一个**信息渠道**，和飞书、微信、Web 并列。一个 enkeep 用户在 Jarvis 的「Agents」里能：

- 看到自己的会话：列表、状态（工作中 / 需要你 / 完成）、历史内容、实时输出；
- 发消息（含图片）、中断、新建会话、改名、关闭；
- 在手机或手表上回答工具授权，之后还有提问和计划审批。

接入方式用 Jarvis 的通用 daemon 规范（Jarvis 仓库 `docs/daemons.md`，已合并）：

- enkeep 的 platform-server 开一个 WebSocket 端点；
- 用户那台 Mac 上的 `jarvisd node` 按 `~/.jarvis/daemons.json` 去连这个端点，带 Bearer token 和子协议 `jarvis-runtime.v1`；
- 连上以后双方说的是 Jarvis 的 runtime 协议。

**Jarvis 那边不用改任何代码。** 规范由 enkeep 这边自己实现，不引用 Jarvis 仓库的代码。

```
 手机 / 手表 ── Jarvis hub ── jarvisd node（同一台 Mac）
                                   │ ws://127.0.0.1:<port>/api/jarvis/runtime
                                   │ Bearer <per-user token>，子协议 jarvis-runtime.v1
 ┌─────────────── enkeep platform-server（宿主机，Server 层）──────────────┐
 │ channel-lark │ channel-wechat │ web-channel │ channel-jarvis（新增）       │
 │        投递网关：turn_runs / 幂等 / 配额 / 审计 / channel_turn_origins      │
 └───────────────────────── docker exec（NDJSON daemon 协议）────────────────┘
                     每个租户一个容器（Runtime 层，DSH）
```

## 2. 现状和缺口（来自源码调研）

| Jarvis 协议要的东西 | enkeep 现在有的 | 缺口 |
| --- | --- | --- |
| **会话行**：id、标题、cwd、状态、更新时间、rev、最后一句 | 会话 id 用 `session_routes.id`（`ses_<hex>`，正好符合 Jarvis 的 id 规则）；有 `listSessions`；有 `getCurrentTurnStatus`（running / queued / waiting_approval / recovery_required） | 没有 rev；`session_routes.updated_at` 不会随消息更新；状态要从 turn_runs 和待审批两处拼出来 |
| **历史 items**：每会话递增的 seq；用户 / 助手文字、思考、工具调用（名字 + 参数）、工具结果、图片、提示 | `web_messages` 只有用户消息和每轮最终的 `replyText`；`web_events` 只有 `tool_status`（工具名）和 `turn_status`；rowid 是全局的 | **工具参数、结果、图片、压缩都没有落盘**。完整的 DSH 原生事件其实已经以 `turn/event`（带 DSH seq）的形式到了宿主机，但被丢掉了；容器里也没有分页读事件的 op |
| **实时推送**：连续 seq 区间、逐字输出 | Web UI 每 500 ms 轮询 `/events` | 没有推送。逐字输出可以从 `assistant_delta` 来 |
| **发消息**：按 client_msg_id 幂等 | `dispatchInbound`（`idempotency_records`）；运行中的消息一律排队 | 没有 steer：手机上「插话」只会排到下一轮 |
| **中断 / 改名 / 关闭** | 分别有 `cancelCurrentTurn`、`updateSession`、`archiveSession` | 无 |
| **新建会话** | `createSession` 默认返回这个 space 的 canonical 会话，`forceNew` 才新建；不幂等 | 要定 cwd → space 的映射 |
| **授权卡片** | 容器里的 `ExternalInteractionService` 挂起审批；daemon 推 `approval/asked` / `approval/decided`；`answerApproval` op；平台有 `/api/interactions/approvals` | ① 宿主侧桥接只在 demo-runner 里，CLI 部署拿不到审批；② **审批 60 秒就过期**；③ 拒绝时不能带理由 |
| **提问 / 计划审批** | 无（容器组合里没有 userQuestions，`ask_user_question` 不会生效） | 要先让容器组合支持提问 |
| **鉴权** | 只有 cookie + CSRF + Origin 必须是 `http://127.0.0.1:<port>`；没有 upgrade 处理，没有 WebSocket 依赖 | 新增每用户的 Bearer token 和 WebSocket 端点 |

调研中顺带发现的现有缺陷，和这件事相关的在 P0 里修：

- 渠道管理里，只要 `type !== 'wechat'` 就一律交给 Lark 的管理器（`channel-routes.ts`）。新渠道会被当成飞书去建 transport。
- 以下几处写死只认 Lark / 微信：任务投递只认 `lark|wechat`，后台任务的 chat 匹配写死 `'lark'`，补漏扫描只扫 `type='lark'`。
- `ContinuationWatcher` 不检查 `origin.channel`。会话被多个渠道共用时，可能发错渠道。
- 微信按 `route.channel` 兜底，可能把 Web 里发的消息转出去。
- `pollEvents` 遇到 `session_recovery_required` 会直接 500。
- `send_message` / `send_file` 工具写的助手消息不产生 web_events，所以不会实时刷新。

## 3. 设计

### 3.1 新包 `@enkeep/channel-jarvis`（纯逻辑，可离线单测）

| 模块 | 职责 |
| --- | --- |
| `endpoint` | 处理 WebSocket 握手和帧：只接受文本消息，一条消息就是一个 JSON；单条上限 64 MiB；回应 ping；同一个账户来了新连接就替换旧连接。用 `ws`（锁文件里已有，作为传递依赖），在这个包里显式声明 |
| `peer` | 双向 JSON-RPC：请求、应答、事件，两边都能发请求 |
| `runtime` | 协议的 runtime 一侧，规则照 Jarvis 的 `docs/runtimes.md`：先发 `runtime.hello`；推 `runtime.sessions`；`session.watch` 的补发和 seq 连续性；逐字输出节流（≤ 120 ms 一次）；`interaction.create` 等手机回答；`client_msg_id` 只投递一次 |
| `projection` | 把 enkeep 的数据映射成 Jarvis 的会话行和 items（见 3.4、3.5） |
| `mapper` | DSH `SessionEvent` → Jarvis item。工具名对齐 Claude（`bash`→`Bash`、`read`→`Read`…），参数名不变；`light` 截断（文字 24 KB、工具输出 4 KB）。照规范自己实现 |

### 3.2 Platform-server 改动

- **端点**：在 server.ts 已有的 socket 跟踪旁边加 `server.on('upgrade')`，路径 `/api/jarvis/runtime`，顺序如下：
  1. 复用 `validateHost`（Host 必须是 `127.0.0.1:<port>`）；
  2. **带 `Origin` 头的一律拒绝**。浏览器发起的 WebSocket 必然带 Origin，jarvisd 不带，这样就挡住了跨站 WebSocket 劫持，代替 CSRF；
  3. 校验子协议；
  4. 校验 Bearer token；
  5. 交给这个用户的 `JarvisChannelRuntime`。
- **渠道账户**：在 `channel_accounts` 里加 `type='jarvis'`，一个用户一个；`defaultSpaceId` 用作新建会话的兜底空间。
- **token**：
  - 在 `POST /api/manage/channels/accounts {type:'jarvis'}` 时生成：32 字节随机数，只显示一次。
  - 库里只存 sha256（和登录会话 token 的做法一样），比较用常量时间。
  - 支持轮换（PATCH）和吊销（DELETE），这两个操作和连接的建立 / 断开都写审计日志。token 不进日志。
- **`ChannelManagementService` 按类型分发**：lark / wechat / jarvis 各走各的管理器，未知类型直接拒绝，不再默认交给 Lark。
- **`JarvisRuntimeManager`**：和 `WeChatRuntimeManager` 同构，按账户启动或停止。它不需要外发 transport：连接是 Jarvis 的 node 连进来的。
- **Web UI**：在「渠道」里加「Jarvis」，用来生成 token，并显示一段 `daemons.json` 示例（只用占位符）。渠道标签表里加 `jarvis`。

用户在自己 Mac 上的 `~/.jarvis/daemons.json`：

```json
{"daemons": [{"id": "enkeep", "name": "Enkeep", "agent": "dsh", "launcher": "enkeep",
  "url": "ws://127.0.0.1:<port>/api/jarvis/runtime", "token_file": "<token-file>"}]}
```

jarvisd node 和 enkeep 在同一台 Mac 上时，走 127.0.0.1 就够了，不用对外暴露端口。别的机器上的用户要连，需要隧道或反向代理，并且代理要改写 Host 头，这部分不在本期范围（见 §6）。

### 3.3 两层之间的接口：DSH 原生事件（runtime-runner 改动）

这一步就是之前讨论过的「server 层 / runtime 层用 DSH 原生会话做接口」。它不只给 Jarvis 用，以后 Web 和飞书卡片也能从这里拿到完整内容。

- **新 daemon op `readSessionEvents`**：参数 `{sessionId, afterSeq?, beforeSeq?, turns?, limit, maxBytes}`，返回 `{events, firstSeq, lastSeq, hasMore, generation}`。
  - 只读：用 DSH 的会话持久化读 header 和日志，**不激活 Agent，不写 `storages/`**。
  - 每页受字节上限约束，不超过 10 MiB 的帧上限。`exportForkSeed` 是整段导出、还会重排 seq，不能拿来用。
- **新 daemon op `readAttachment`**：参数 `{sessionId, attachmentId}`，给 Jarvis 的 `session.image` 用。
- **宿主侧订阅 `turn/event`**：每个用户的 `DaemonTransport` 都订阅它的 `'stream'`。这些事件今天已经带着 DSH seq 到了宿主，只是被丢掉了。
  - 宿主不另外落库：实时的直接推，断线后用 `readSessionEvents(afterSeq)` 补。daemon 广播不带回放，所以靠这一步补洞。
- **seq 和 history**：
  - seq = DSH seq + 1。
  - `history` = `dsh:<dsh_session_id>`。会话重置换了 generation，`dsh_session_id` 跟着变，Jarvis 就会整页重取。
- **平台自己产生的提示**（命令回复、`turn_failed` 的错误码、需要恢复）不在 DSH 事件里。做法是：作为 `notice` 合进推送流，占用 seq 区间里的空档（items 可以为空，只推进 seq）；或者先不显示（见 §7 待定 3）。

### 3.4 会话行（`listSessions`）

| 字段 | 来源 |
| --- | --- |
| `session_id` | `session_routes.id`。只列 active 的，不列子 Agent 的会话 |
| `title` | route 的 title，没有就用 space 名 |
| `cwd` | 容器里的 `<spacesDir>/<folder>`。新建会话时用它反查 space |
| `space_id` / `space_name` | space 的 id 和名字。Jarvis 按空间分组，node 会给 space_id 加上前缀 |
| `status` | 有待审批或待回答的提问、需要恢复 → `blocked`；platform 的轮次在 running / queued，或者 runtime 自己发起的续轮（后台任务完成后接着跑的那一轮）正在跑 → `working`；其余按最近一轮的来源判断 `done` / `idle`，见下面的「已看与未看」 |
| `updated_at` | 最近一条消息或事件的时间 |
| `rev` | 最新的 DSH seq（取 `turn/event` 里看到的最大值，冷启动时由 `readSessionEvents` 给出） |
| `last_text` | 最后一条助手消息（web_messages） |
| 列哪些 | 正在跑的、在等审批的、手机碰过的一定列；其余按最近 N 天补到 M 个 |

#### 已看与未看（issue #96）

Jarvis 只根据 runtime 报的状态来决定「完成未看」和「做完了」的推送：报 `done` 的会话，要等你在 App 里打开过才算已看；报 `idle` 的，直接算已看，也不推送。enkeep 按会话**最近一轮结束的轮次**是从哪里发起的来决定报哪个：

| 最近一轮 | 报 |
| --- | --- |
| 飞书 / 微信发起的（不论成功、失败还是被中断；也包括由它派生的续轮，以及投递到聊天里的定时任务） | `idle`：结果已经发到那个聊天里 |
| Jarvis 发起的（包括由它派生的续轮） | `done` |
| 没有投递到任何聊天的定时任务 | `done` |
| Web 页面发起的，或者来源没有记录 | `idle`：当时人在电脑前 |
| 在这个 Jarvis 账户创建之前就结束了 | `idle`：第一次连上时不会冒出一堆未看 |
| 一轮都还没结束过 | `idle` |

- **怎么取最近一轮**：platform 的轮次看 `turn_runs` 里最近一条已结束的；runtime 自己发起的续轮不在 `turn_runs` 里，从会话最新 2000 条事件中找最近一条已结束的 `turn_status`。两者取结束得较晚的那个。
- **续轮的来源**：每个续轮的 `originTurnId` 指向前一轮，沿着这条链最多往回找 50 轮，直到找到有来源记录（`channel_turn_origins`）的那一轮。找到过的结果会记下来，链再变长时只多查一步。
- **缓存**：每个会话的判断结果按「事件水位 + 最近一条轮次记录」缓存，水位和轮次都没变就不重算。所有查询都走按会话、按轮次的索引，有单测检查执行计划。
- **一个已知的取舍**：只看最近一轮。如果 Jarvis 发起的一轮你还没在 App 里看，接着同一个会话又在飞书完成了一轮，这个会话会显示为已看。
- **续轮的「工作中」**：根据 runtime 推过来的 DSH `turn/start` / `turn/end` 事件，在内存里跟踪正在跑的续轮。runtime 断开时清掉；超过 2 小时没有任何事件也不再算工作中。平台重启时如果有续轮正在跑，要等它下一个事件到了才会重新显示为工作中。

### 3.5 各项操作

| Jarvis 调用 | enkeep 实现 |
| --- | --- |
| `session.items` / `session.watch` | 读 `readSessionEvents` 后经 mapper 转换，再分页（`before_seq` / `after_seq` / `turns` / 区间）。watch 先补发 `since_seq` 之后的内容，再接实时事件；每批带 `from_seq` / `to_seq` |
| 逐字输出 | 用 `turn/chunk`，或者 web_events 的 `assistant_delta` 累计成整段，作为 `session.delta` 推；一段结束推空串 |
| `session.send` | 构造 `InboundEnvelope`：`channelContext={channel:'jarvis', accountId, nativeEventId: client_msg_id}`，幂等键 = `idem_jarvis_` + sha256(accountId + client_msg_id) 的前缀，然后调 `dispatchInbound`。这样 `channel_turn_origins` 会把来源记成 jarvis。图片是 base64，先经现有的 ingestor（改个通用名）落到 `.attachments/incoming/`，再作为附件引用；单张上限按 runtime 的 20 MiB 卡 |
| `session.interrupt` | `cancelCurrentTurn(userId, routeId)` |
| `session.start {cwd, prompt?}` | 用 cwd 匹配到 space，就 `createSession({spaceId, forceNew:true})`；匹配不到就用账户的 `defaultSpaceId`。有 prompt 就接着发出去。返回会话行 |
| `session.rename` / `session.close` | `updateSession({title})` / `archiveSession` |
| 终端类调用 | 不声明这项能力，node 自己回 `unsupported` |

**渠道之间的边界：**

- Jarvis 是用户本人的「全景窗口」：看得到自己所有会话的全部内容，不管消息是从哪个渠道发起的。
- 飞书 / 微信只回复从自己那里发起的轮次。现在已经按 `channel_turn_origins` 过滤，所以从 Jarvis 发起的轮次不会出现在飞书群里。这一点依赖 P0 修好 `ContinuationWatcher` 的渠道检查，以及微信的 `route.channel` 兜底。
- 定时任务、后台任务的结果不需要单独推给 Jarvis：会话的 rev 一变，Jarvis 的 hub 就会显示「完成未看」并推送通知。任务投递把 `jarvis` 作为合法目标，什么也不做。

### 3.6 授权、提问、计划审批

- **前置**：把审批的宿主侧桥接从 demo-runner 挪进 platform-server，成为通用的 `ApprovalBridge`，订阅所有用户的 `approval/asked` / `approval/decided`。这样 CLI 部署和 LaunchAgent 部署也都有审批，Web、飞书、Jarvis 共用一份。
- **授权卡片**：收到 `approval/asked` 就调 `interaction.create`：
  - `kind: 'permission'`
  - `id` = 审批 id
  - `tool_name` 映射成 Claude 的名字
  - `tool_input` 取这一步 `tool-call` 的参数（从 `turn/event` 里拿）
  - `summary` = safeSummary，`reason` 原样带上

  手机回答 `{allow}` 后调 `answerApproval(allowed-once | rejected)`。
- **多个渠道同时能答**：先答的生效。`approval/decided` 到了就对 Jarvis 发 `interaction.cancel`，把卡片撤掉。
- **超时**：现在 60 秒就过期，在手机上根本来不及答。改成按来源配置：Jarvis 连着时默认 10 分钟（可配），同时用 `timeout_seconds` 告诉 Jarvis，让卡片和 enkeep 同时过期。
- **拒绝时附理由**：DSH 的审批结果里没有理由字段。先拒绝，再把理由作为下一条消息排进队列（来源记成 jarvis）。Jarvis 的 DSH 插件也是这么做的，只不过它用 steer 插进当前这一轮。
- **提问（`ask_user_question`）和计划审批**：
  1. 先在容器组合里加上 userQuestions 和 `ask_user_question`；
  2. 加 daemon 事件 `question/asked`、`question/answered` 和 op `answerQuestion`；
  3. 平台加路由，Web 和飞书各出一张卡；
  4. Jarvis 发 `kind: 'question'` / `'plan'`。

  提问可能比卡片的等待时间长，晚到的回答要能交回去，对应 DSH 的 `userQuestions.answer`。

### 3.7 安全

- 端点只在已有的 127.0.0.1 监听上开，必须先过 `validateHost`。带 Origin 的请求一律拒绝。只认子协议 `jarvis-runtime.v1`。
- token 一个用户一个，只存 hash，可轮换、可吊销，审计记录建立、断开、吊销。
- 每次调用都按 token 对应的 userId 做租户过滤，会话 id 必须属于这个用户。管理员通过 Jarvis 也只看得到自己的会话。
- 不在 `caps` 里声明 `assistant`。Jarvis 那边对 daemon 也会去掉它，并且不给 `mcp.*`。
- 每条消息不超过 64 MiB；图片按 runtime 的限制（单张 20 MiB、每条消息 20 张）。
- 不新开端口，不碰 3000 / 3080。测试全部离线，只用合成数据。

## 4. 分期

每期都能单独上线、单独回滚。

| 期 | 内容 | 上线后在 Jarvis 里能做什么 | 规模（粗估） |
| --- | --- | --- | --- |
| **P0 前置修正** | 渠道管理按类型分发；`ApprovalBridge` 挪进 platform-server（CLI 和 LaunchAgent 部署都有）；修 `ContinuationWatcher` 的渠道检查、微信的兜底、`pollEvents` 遇到未知类型时报错、`send_message` 不产生事件 | （没有新功能。修好的是 Web 和飞书的问题） | ~600 行 + 测试 |
| **P1 只读渠道** | `channel-jarvis` 的端点、peer、runtime、projection、mapper；token 和账户；daemon op `readSessionEvents` / `readAttachment`；宿主订阅 `turn/event`；会话列表、历史、实时推送、逐字输出 | 看到所有会话、状态、完整对话（思考、工具调用、diff、结果、图片），实时跟进 | ~2000 行 + 测试，要重打 runtime 镜像 |
| **P2 可写** | 发消息（文字和图片）、中断、新建、改名、关闭；来源记为 jarvis；Web UI 的渠道页 | 在手机上驱动 enkeep 会话；飞书不会收到从 Jarvis 发起的轮次 | ~800 行 + 测试 |
| **P3 交互** | 授权卡片（按来源配置超时、先答的生效、撤卡、拒绝附理由）；然后提问和计划审批（改容器组合，Web、飞书一起补上） | 在手机或手表上批准工具、回答提问 | 授权 ~500 行；提问和计划 ~1000 行（含 Web、飞书） |

## 5. 测试

- **单测（离线）**：
  - mapper 用合成的 DSH 事件夹具：文字、思考、工具调用和结果、图片、压缩、中断；
  - projection：状态推导、rev、列表挑选；
  - runtime：watch 补发和连续性、逐字节流、`client_msg_id` 去重；
  - 端点：Host 不对、带 Origin、子协议不对、token 不对、token 吊销后、新连接替换旧连接；
  - `ApprovalBridge`：多个渠道同时答、过期、撤卡。
- **集成**：在 platform-server 的测试里起一个假的 Jarvis node（Node 自带的 WebSocket 客户端），走完整套：hello → 列表 → 发消息 → 实时推送 → 中断 → 审批，用确定性的 demo 模型。
- **Docker 验收**：`readSessionEvents` 加进 runtime-runner 的 `test:docker`。要验证读冷会话不激活 Agent、不写 `storages/`，大会话分页不超过帧上限。
- **真实端到端（手动，靠环境变量启用，不进 CI）**：`packages/demo-runner/tests/jarvis-node-docker-e2e.test.ts`。
  - 环境：真的 Docker runtime，加一个真的 `jarvisd node --stdio`（临时 HOME，`daemons.json` 指向测试用的 platform）。测试脚本扮演 hub，模型用确定性的 demo 模型。
  - 覆盖：账户只能由管理员建、一个用户一个；node 连上后的列表；新建会话；发消息（重发只进一次）；逐字输出；翻页和推送的连续性；`/` 命令被拒；图片；授权卡片（批准后命令执行；拒绝时附的话作为下一条消息到达）；提问卡片（回答回到模型）；中断；改名；终端调用被拒；关闭；看不到别的用户的会话；换 token 后连接断开。
  - 运行：

    ```bash
    JARVISD=<jarvisd> ENKEEP_RUNTIME_IMAGE=<image> ENKEEP_LLM_ENABLED=0 \
      pnpm --filter @enkeep/demo-runner exec vitest run tests/jarvis-node-docker-e2e.test.ts
    ```

  enkeep 仓库里不含 Jarvis 的代码。

## 6. 不做或以后再做

- **别的机器上的 jarvisd 连 enkeep**（多个用户各在自己机器上）：需要隧道或反向代理，代理要改写 Host 头、加 TLS，并重新评估暴露面。
- **steer**：手机上「插话」先按排队处理。要即时插进当前轮次，得在投递网关里开 steer。
- **子 Agent 的会话**：不单独列出，在父会话里看。
- **Web 和飞书改用 DSH 原生事件**：P1 的接口建好后可以逐步迁过去，不在本方案范围。

## 7. 已定（实现时的决定）

1. **token 粒度**
   - 一个用户一个 Jarvis 账户。现在只有管理员能建：普通用户调 `POST /api/manage/channels/accounts {type:'jarvis'}` 回 403。
   - token 只显示一次，库里只存 sha256（迁移 046 `channel_account_tokens`，`user_id` 唯一）。
   - 换 token：`POST /api/manage/channels/accounts/:id/token`。停用或删除账户会吊销 token，并断开正连着的 Jarvis。
2. **历史的来源**：用 DSH 原生事件，经 runtime 的只读 op `readSessionEvents` / `readAttachment` 读取；实时内容来自 `turn/event` 和 `turn/chunk`，由 `RuntimeSessionEventHub` 按用户分发。
3. **平台自己产生的提示**（命令回复、错误码、需要恢复）：第一版不合进推送流。会话行的状态和 `last_text` 能反映出来；以后有需要再加。
4. **`/` 命令**：Jarvis 发来的一律拒绝（`unsupported`，并说明原因）。停止、新建、改名在 Jarvis 里有各自的按钮。
5. **审批超时**
   - 容器里等审批的时长用 `ENKEEP_APPROVAL_TIMEOUT_MS` 设（1 秒到 24 小时，默认仍是 60 秒），对所有渠道生效，需要用新镜像重建容器。
   - 卡片会在 runtime 真正过期的同时从手机上撤掉（`expiresAt`）。
6. **提问**
   - 装的 DSH（0.2.1-rc.5）没有提问的能力，所以 enkeep 自己实现了 `ask_user_question` 工具，入参和 DSH 的一致。
   - 只在 runtime 环境里 `ENKEEP_USER_QUESTIONS=1` 时才组装这个工具。为某个用户新建 runtime 时，如果他有启用中的 Jarvis 账户，就自动打开；其他人保持部署时的全局设置。改了要等这个用户的 runtime 重建才生效，不会强制重启。
   - 等待时长用 `ENKEEP_QUESTION_TIMEOUT_MS` 设，默认 10 分钟。过期以后才到的回答，作为用户的下一条消息发出去。
   - Web 在审批弹窗里也能回答提问。飞书暂不支持。
7. **计划审批**：rc.5 没有 plan mode，这一版不做。

## 8. 实现要点：enkeep 这一侧要实现的协议

本节是 enkeep 实现的行为说明，所有内容都按 Jarvis 的 daemon 规范来，不引用 Jarvis 的任何代码。

### 8.1 连接

- 端点：`GET /api/jarvis/runtime`，在 platform-server 已有的 127.0.0.1 监听上做 WebSocket 升级。
- 依次检查，有一项不过就不升级：
  1. 先过 `validateHost`；
  2. 带 `Origin` 头的回 403；
  3. `Authorization: Bearer <token>` 对应一个启用中的 `jarvis` 渠道账户，否则回 401；
  4. 子协议要包含 `jarvis-runtime.v1`，否则回 400；
  5. 都通过才升级，并回同一个子协议。
- 帧：一条文本消息就是一个 JSON 对象，末尾的换行可有可无，单条最大 64 MiB。对 ping 回 pong。
- 同一个账户来了新连接时，关掉旧连接，以新的为准。

### 8.2 RPC

- 帧的形状：
  - 请求 `{"id","method","params"}`；
  - 应答 `{"id","result"}` 或 `{"id","error":{"message","code"}}`；
  - 事件 `{"event","params"}`。
- 两边都能发请求。enkeep 的请求 id 用 `e` 开头的前缀。

### 8.3 enkeep → node

- 连上后**必须先发**请求 `runtime.hello`，参数：

  ```json
  {"runtime": "enkeep", "name": "Enkeep", "agent": "dsh", "version": "<ver>", "instance": "<每个进程一个随机值>",
   "launcher": "enkeep", "launcher_model": "DeepSeek Harness",
   "caps": {"start": true, "send": true, "interrupt": true, "rename": true, "close": true}}
  ```

  node 回 `{protocol, node_version, hub, features}`。`hub` 为 false 表示 node 现在没连着 hub，这时不要等手机回答。
- 事件 `runtime.sessions {sessions}`：
  - 推全量，变化时推（300 ms 防抖），另外每 30 秒推一次兜底；
  - 有卡片在等手机回答的会话，状态推成 `blocked`；
  - 手机最近发过消息或新建过的会话（最近 50 个）一直列着。
- 事件 `session.items {session_id, items, history, from_seq, to_seq}`：只给被 watch 的会话推。每批的 `from_seq` 必须等于上一批的 `to_seq`；中间丢了，就如实写出新的 `from_seq`。
- 事件 `session.delta {session_id, text}`：
  - text 是到目前为止的整段文字；
  - 第一次立刻发，之后最多 120 ms 发一次；
  - 空串表示这段文字结束了；
  - 只给被 watch 的会话发。
- 请求 `interaction.create {interaction, timeout_seconds?}`，回 `Resolution`。
  - 遇到错误码 `node_gone`（node 重启了），2 分钟内每秒用**同一个 id** 再问一次。
  - 回 `{dismiss:true}` 表示手机没有答。卡片留给 Web 或飞书，enkeep 这边不作答。
- 事件 `interaction.cancel {id}`：这张卡已经在别处答了、过期了，或者撤回了。

### 8.4 node → enkeep 的请求

| 方法 | 参数 → 返回 |
| --- | --- |
| `session.items` | `{session_id, before_seq?, after_seq?, turns?, limit?, from_seq?, through_seq?}` → `{items, has_more, more_after?, history, to_seq, from_seq?}`。规则：<br>• 什么都不带：取最后 `turns` 轮（默认 2），或最后 `limit` 条；<br>• `before_seq`：往前翻；<br>• `after_seq`：取之后的，返回带 `from_seq = after_seq`，还有更多时 `more_after: true`；<br>• `from_seq` + `through_seq`：取这一段（返回 `{items, more}`）。<br>一「轮」从一条人发的 user text 开始 |
| `session.item` | `{session_id, item_id}` → 被截断的那条 item 的全文 |
| `session.image` | `{session_id, item_id}` → `{mime, data}` |
| `session.watch` | `{session_id, since_seq}` → `{ok}`。`since_seq > 0` 时先补发它之后的全部内容，再接实时推送 |
| `session.unwatch` | `{session_id}` → `{ok}` |
| `session.send` | `{session_id, text, images?, client_msg_id}` → `{ok}`。同一个 `client_msg_id` 只投递一次，重试时直接拿第一次的结果 |
| `session.interrupt` / `session.rename {title}` / `session.close` | → `{ok}` |
| `session.start` | `{cwd, prompt?}` → `{session: <行>}` |
| 其他方法 | 回 `code: unsupported` |

### 8.5 DSH 事件 → item

- 每个事件的 `seq` = DSH seq + 1。一个事件可以产生多条 item，id 写成 `<seq>#<序号>`。不产生 item 的事件也要推进 seq。
- 各类事件的映射：

| DSH 事件 | 映射成 |
| --- | --- |
| `user/message` | 只取人发的（source 为用户本人或 enkeep 投递的消息），注入的上下文不显示；文字 → `{role:user, kind:text}`，图片 → `image` |
| `assistant/message` | reasoning → `thinking`；text → `{role:assistant, kind:text}`；tool-call → `{kind:tool_use, tool_name, tool_input, tool_use_id}` |
| `tool/result` | `{kind:tool_result, tool_use_id, is_error, text}`；结果里的图片单独拆成 `image` item（带 `tool_use_id`） |
| 轮次被中断 | notice「已中断」 |
| 出错 / 达到输出上限 | 对应的 notice |
| 上下文压缩 | notice |

- 工具名对齐 Claude：`bash`→`Bash`、`read`→`Read`、`edit`→`Edit`、`write`→`Write`、`grep`→`Grep`、`glob`→`Glob`、`web_fetch`→`WebFetch`、`web_search`→`WebSearch`、`todo_write`→`TodoWrite`、`ask_user_question`→`AskUserQuestion`、`read_image`→`Read`。参数名不改，其他工具保留原名。
- 长度截断：
  - 页和推送里，文字最多 24 KB，工具输出最多 4 KB；截断时带 `full_size`，末尾加一行说明：
    - 工具输出：`…（已截断，点开看全文，共 N 字节）`；
    - 其他文字：`…（已截断，共 N 字节）`；
  - 全文通过 `session.item` 取。
- 图片在页和推送里只是占位 `{mime, size?, width?, height?, lazy:true}`，数据通过 `session.image` 取。
- 每个 item 都带 `ts`（ISO 时间），取自事件的时间戳。

## 9. 上线与启用（运维）

1. 合并以后，用 `scripts/deploy-release.mjs` 发布（`docs/deployment-recipe.md`）。runtime 镜像要重新构建：容器里的读历史、提问工具和审批超时都在新镜像里。
2. 管理员在 Web 的「渠道」页建 Jarvis 账户，把只显示一次的 token 存到 jarvisd node 那台机器上的 `<token-file>`（权限 0600），然后在 `~/.jarvis/daemons.json` 里加一项：

   ```json
   {"daemons": [{"id": "enkeep", "name": "Enkeep", "agent": "dsh", "launcher": "enkeep",
     "url": "ws://127.0.0.1:<port>/api/jarvis/runtime", "token_file": "<token-file>"}]}
   ```

   node 大约 10 秒内会自己读到这个文件并连上，不用重启。连上以后，「渠道」页的 Jarvis 卡片显示「已连接（自 …）」、最近使用时间和 token 的创建时间（点「刷新」重新读取）；管理 API 里对应账户的 `jarvis` 字段（`connected`、`connectedAt`、`lastConnectedAt`、`lastDisconnectedAt`、`lastUsedAt`、`tokenCreatedAt`），不含 token 或它的 hash。

   **不用 Web 的做法（同一台机器上的运维）**：用 demo-runner 的命令行直接签发或吊销，所有值都从参数给，没有默认值：

   ```bash
   node packages/demo-runner/dist/demo-runner.js jarvis-token issue \
     --data-dir <data-dir> --user <username> --token-file <token-file>
   node packages/demo-runner/dist/demo-runner.js jarvis-token revoke \
     --data-dir <data-dir> --user <username>
   ```

   - `issue`：这个用户还没有 Jarvis 账户就建一个（和 API 一样，只限启用中的管理员），已有就换 token。token 只写进 `<token-file>`（新建时权限 0600；是符号链接或属于别的用户的文件一律拒绝），屏幕上只打印账户 id 和文件路径。不给 `--token-file` 时，token 打印到 stdout 一次，stderr 上有警告。
   - `revoke`：删除这个用户的 Jarvis 账户和它的 token，和卡片上的「删除」（API 的 DELETE）效果一样。
   - 平台运行时也可以用：直接打开 `<data-dir>/platform.db`（WAL，带 busy timeout，每次只做很短的写入），不起服务、不跑迁移；签发、换、吊销都写审计日志（`via: 'cli'`）。
   - 命令行关不掉正在运行的平台上的连接：旧 token 立即不能再连；还用着旧 token 的连接，会在下一次检查时被平台断开（它的下一个请求，或者最多约 30 秒后的会话列表刷新）。
3. 提问工具在这个用户的 runtime 下一次重建时打开。重建由发布脚本在空闲时做，也可以由管理员重启这个用户的 runtime。
4. 审批卡片在手机上的停留时间，由部署设置的 `ENKEEP_APPROVAL_TIMEOUT_MS` 决定（默认 60 秒；想在手机上从容回答，可以设成比如 600000）。
