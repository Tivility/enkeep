# @enkeep/protocol

Cross-process wire types, strict JSON parser with limits, error envelopes, and branded string types for Enkeep platform-container communication.

## 职责 (Responsibilities)

1. **跨进程 Wire 类型定义 (Cross-process Wire Types)**
   - 定义 Enkeep 平台服务与容器内 DSH runtime 之间的所有跨进程线协议类型（如容器握手 `ContainerHandshake`、心跳 `ContainerHeartbeat`、运行状态流转 `RunStateChangeEvent`、日志批处理 `RunLogBatch`、人工审批 `ApprovalRequest` 等）。
   - 定义标准 Wire Headers 常量（`x-request-id`, `x-enkeep-container-id`, `x-enkeep-session-id`, `x-enkeep-run-id` 等）。

2. **严格 JSON 解析器与安全限制 (Strict JSON Parser with Limits)**
   - 提供安全受限的 `strictJsonParse` 与 `strictJsonStringify`。
   - 内置 payload 大小限制（默认 4MB）、嵌套层级上限（默认 64 层）、最大 key 数量限制（默认 50,000）及字符串长度限制。
   - 原型链污染防护（过滤/拦截 `__proto__`, `constructor`, `prototype`）。

3. **标准错误与响应信封 (Standard Error & Response Envelope)**
   - 定义跨边界一致的 `ErrorEnvelope` 与 `SuccessEnvelope` 结构。
   - 提供标准错误码 `ProtocolErrorCode` 与 `ProtocolError` 基类。
   - 支持结构化错误详情 `details`、幂等重试标志 `retryable` 与追踪标识 `requestId`。

4. **强类型 Branded/Opaque String ID (Type-safe Branded Types)**
   - 提供 `SessionId`, `RunId`, `ExecutionId`, `TaskId`, `WorkspaceId`, `ContainerId`, `UserId`, `RequestId` 等名义化字符串类型。
   - 提供运行时校验与安全构建函数（`makeSessionId`, `isValidIdFormat`, `parseBranded` 等）。

---

## 非职责 (Non-Responsibilities)

1. **无 DSH 依赖 (No DSH Dependency)**
   - 绝不依赖 DeepSeek Harness (DSH) 核心库或实现细节，保持完全原子化与解耦。
2. **无传输层实现 (No Transport / Network Implementation)**
   - 不包含 HTTP 客户端、HTTP 服务端、Socket 连接或 Unix domain socket 处理逻辑（由 `@enkeep/dsh-platform-client` 或平台服务实现）。
3. **无业务逻辑与存储 (No Business Logic or Persistence)**
   - 不包含状态机执行、数据库存储、权限校验或审计落盘等具体业务逻辑。
