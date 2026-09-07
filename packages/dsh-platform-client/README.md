# @enkeep/dsh-platform-client

HTTP-over-Unix-domain-socket client for container DSH communicating with the Enkeep platform.

## 职责 (Responsibilities)

1. **HTTP-over-UDS 传输通信 (HTTP-over-Unix-Domain-Socket Transport)**
   - 提供容器内 DSH runtime 调用 Enkeep 平台服务的高效通信通道，完全基于 Unix Domain Socket (UDS)，避免暴露 TCP 端口。

2. **认证与请求追踪 (Auth & Request Tracing)**
   - 支持静态或异步动态 Bearer Token 认证。
   - 自动生成或传递唯一请求 ID（`x-request-id` header），并在响应中透传。

3. **超时控制与主动取消 (Timeout & Cancellation)**
   - 支持客户端默认及单次请求粒度的超时控制。
   - 完整支持 `AbortSignal` 外部取消机制。

4. **幂等有限重试与退避 (Bounded Idempotent Retries & Backoff)**
   - **严格限定仅幂等请求重试**：默认仅对 `GET`, `HEAD`, `PUT`, `DELETE`, `OPTIONS` 或显式标记 `idempotent: true` 的请求在遇到瞬态错误（如网络断开、502、503、504、429）时触发有限重试；非幂等请求（如 `POST`）坚决不重试。
   - 实现带抖动（Full Jitter）的指数退避策略，并优先遵循服务端的 `Retry-After` 头。

5. **响应体大小防御 (Response Body Size Limit)**
   - 流式读取响应流并在超出限制（默认 4MB）时立即销毁请求与流，防御内存溢出。

6. **标准协议与错误集成 (Protocol & Error Mapping)**
   - 深度集成 `@enkeep/protocol`，自动序列化/解析严格 JSON。
   - 自动映射服务端 `ErrorEnvelope` 及 HTTP 状态码为强类型的 `ClientHttpError` / `ClientConnectionError` / `ClientTimeoutError`。

---

## 非职责 (Non-Responsibilities)

1. **不承载业务端点 (No Business Endpoints)**
   - 纯原子传输客户端，不硬编码任何具体业务路由（如用户会话、审计查询等），仅暴露泛型请求原语（`request`, `get`, `post`, `put`, `patch`, `delete`）。
2. **不监听网络或提供服务端 (No Network Binding / Server)**
   - 仅作为客户端发起 UDS 连接，不启动服务端，不绑定 `0.0.0.0` 或公共网络。
3. **无状态存储与持久化 (No State Persistence)**
   - 不持久化存储调用日志或业务数据。
