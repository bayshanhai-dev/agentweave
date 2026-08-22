# AgentWeave 产品与技术规格

版本：`0.1-draft`  
状态：MVP 规划  
定位：开源、Docker-first、持久化、可恢复、可扩展至分布式集群的协作型 AI Agent Runtime 与 Control Plane。

## 1. 项目定义

AgentWeave 是一个用于创建、运行、协调和监督多个协作型 AI Agent 的开源运行时与控制平面。

用户创建一个 Workstream，并通过第一段对话描述目标。AgentWeave 将第一段对话注册为 PM Agent，随后自动创建默认的 PE、Coder 和 QA Reviewer Agent。这些 Agent 拥有独立会话和角色上下文，通过持久化事件总线交换任务、结果、反馈和阻塞信息，同时共享 Workstream 的目标、任务图和产物。

Human 是网络中的第一等参与者，可以直接与任意 Agent 对话，暂停、恢复或结束整个 Workstream，并审批高风险操作。

MVP 在单台主机上通过 Docker Compose 运行，但 Worker、Provider、消息和任务协议从第一天起为未来分布式 Agent Cluster 设计。

一句话定义：

> AgentWeave is an open-source runtime and control plane for collaborative AI agent networks.

## 2. 要解决的问题

### 2.1 当前 Coding Agent 的局限

- 单个用户通常只对应单个 Agent 会话。
- 多 Agent 之间缺少统一身份、地址和持久化 Inbox。
- Agent 无法可靠地发送、确认、重试和重放消息。
- 多 Agent 的任务、阻塞和依赖缺少统一视图。
- Human 难以同时观察和直接引导多个 Agent。
- 会话、任务、Git 状态和运行状态容易脱节。
- 缺少 Workstream 级别的暂停、恢复、完成和重开语义。
- 缺少统一的审计、审批、重试、恢复和资源治理机制。

### 2.2 现有 Agent Framework 的缺口

LangGraph、CrewAI、AutoGen、OpenHands 等已经提供部分基础能力，但 AgentWeave 关注一个完整的产品体验：

- 从一次自然语言对话启动完整 Workstream。
- 第一段会话自然升级为 PM。
- 自动形成默认工程团队。
- 每个 Agent 都是可直接对话的独立网络节点。
- Human 是网络中的第一等节点，而非外围审批器。
- 所有消息、任务、状态和产物都可持久化和重放。
- Dashboard 同时承担聊天、观察、控制和审批功能。
- Runtime 与具体模型、Provider 和计算节点解耦。
- 本地单机和未来分布式集群使用同一套协议。

## 3. 核心产品体验

```text
Human 创建 Workstream
        ↓
通过第一段 Chat 描述目标
        ↓
第一段 Chat 注册为 PM
        ↓
自动注册 PE / Coder / QA Reviewer
        ↓
PM 分解目标并派发任务
        ↓
Agents 设计、实现、测试和审查
        ↓
Human 可与任意 Agent 对话并引导
        ↓
Workstream 可暂停、恢复和完成
        ↓
所有进度、消息和产物永久保留
```

产品目标：

> Describe a goal once, form an AI engineering team around it, and stay connected to every agent throughout the workstream.

## 4. 核心概念

### 4.1 Workstream

Workstream 是最高层级的持久化工作单元，不是临时 Run，也不是单个 Chat。

它包含：

- Human Goal；
- Repository；
- Agent 团队；
- Chat Sessions；
- Tasks 与 Dependencies；
- Messages 与 Events；
- Approvals；
- Artifacts；
- Git Worktrees；
- Human 指令；
- 状态与恢复点。

生命周期：

```text
draft
→ starting
→ active
→ pausing
→ paused
→ resuming
→ active
→ completing
→ completed
→ archived
```

### 4.2 Agent

Agent 是逻辑身份，例如 PM、PE、Coder、QA Reviewer 或 Human。Agent 不等于进程，也不等于模型。一个 Agent 可以在不同时间由不同 Worker 或模型执行，但其身份、Inbox 和历史保持不变。

### 4.3 Session

Session 是 Agent 的持久化对话上下文，保存 Provider Thread ID、角色指令、对话历史、当前任务、模型配置和最后处理的 Event Sequence。

### 4.4 Run

Run 是一次具体模型执行。Session 可以长期存在，而 Run 可以反复创建和终止。

### 4.5 Worker

Worker 是实际执行 Agent Run 的计算节点。MVP 的 Worker 与 Control Plane 位于同一主机，未来可以运行在局域网主机、云 VM、GPU 节点或 Kubernetes Pod。

Worker 注册：

- 可执行角色；
- 可用模型；
- 工具能力；
- CPU、GPU 和内存；
- Workspace 能力；
- 当前负载；
- 健康状态。

### 4.6 Task

Task 是可执行、可分配、可验收的工作单元，包含目标、Owner、Priority、Acceptance Criteria、Dependencies、Blockers、Status、Artifacts、Review Result 和 Retry Count。

### 4.7 Event

Event 表示已经发生且不可修改的事实，例如 `task.assigned`、`run.started`、`review.failed` 或 `workstream.paused`。

### 4.8 Message

Message 是 Agent、Human 和系统之间的业务通信，支持 Direct、Role、Task、Workstream Broadcast、System Command、Human Steering 和 Approval Request。

### 4.9 Artifact

Artifact 是持久化结果，例如 Git Commit、Diff、测试报告、架构文档、审查报告、截图、Build Log 或 Release Package。

### 4.10 Role Replication 与并行执行

Role Template 与 Agent Instance 必须分离。Role Template 定义角色契约、权限、默认模型和工具；Agent Instance 是一个拥有独立身份、Session、Inbox、Run 历史和可选 Workspace 的实际执行单元。

默认 Workstream 仍然创建一个 PM、PE、Coder 和 QA Reviewer。运行时可以在同一角色下创建多个 Agent Instance，例如 `Coder-1` 和 `Coder-2`，用于处理彼此独立的 Ready Tasks。扩容不是简单复制一个进程，也不会共享同一个 Session。

Orchestrator 在调度前必须检查：

- 是否存在两个或以上互不依赖的 Ready Tasks；
- 是否有可用的 Token Budget、Worker 容量和模型容量；
- 是否需要 Workspace、文件或资源隔离；
- 是否可能产生重复工作、写入冲突或不可合并的副作用；
- 是否超过 Workstream、Role 和 Worker 的并发上限。

满足条件时，Runtime 可以复用空闲 Agent 或排队任务。若判断需要创建同角色的新 Agent Instance，Runtime 只能生成一条包含原因、候选角色、任务范围、预计 Token/资源成本、并发影响和隔离方案的 `scaling.recommendation`，发送给 Human。任何新增 Agent Instance 的扩容都必须由 Human 对该推荐明确批准；Runtime 不得自动扩容。Human 可以批准一次性扩容、批准至 Workstream 完成、拒绝，或修改实例数量与范围。每个任务必须有明确 owner 和 lease；任务完成后由 PM/QA 汇总结果，冲突由 Runtime 暂停并交给 PM 或 Human 处理。

Role Replication 的生命周期包括创建、注册、分配任务、暂停、恢复、空闲回收和归档。扩容和缩容事件必须写入 Event Log，且不能改变既有 Agent 的历史身份。

### 4.11 Agent Authority 与信任边界

Agent 的执行能力与决策权必须分离。每个 Agent Instance 都有一组由 Human 或 Workstream Policy 显式授予的权限标签；角色名称本身不能自动授予高权限。

默认权限等级：

- `executor`：执行已批准的 Task，提交代码、测试和证据；不能改变 Workstream 目标、批准自己的结果、修改全局 Policy 或触发正式 Self-Retro；
- `reviewer`：检查其他 Agent 的结果，提出失败、阻塞和改进建议；不能单独批准自己的产物；
- `lead`：PM、Tech Lead 等受信任 Agent，可以汇总跨任务事实、提出决策和触发 Self-Retro，但仍受 Human Approval、Budget 和 Policy 限制；
- `human_delegate`：Human 明确授予的额外权限，必须有作用域、有效期和审计记录。

Human 可以按 Agent、Role Template 或 Workstream 调整权限。高权限 Agent 的输出必须标记为 `proposal`、`decision` 或 `retro`，并引用 Evidence；未经批准的建议不能自动改变全局任务、角色权限、预算或安全策略。Executor 的普通消息、代码变更和局部判断不能污染整个 Workstream 的质量结论。

Self-Retro 只能由具备 `lead` 或 `human_delegate` 权限的 Agent 发起。Retro 必须使用冻结的事实快照，分别区分事实、推断、建议和待确认事项，并由另一名 Reviewer 或 Human 检查；Coder 等 `executor` 可以提交局部复盘材料，但不能单独发布全局 Retro 或修改长期记忆。

### 4.12 Use-Case Flavor 与 Domain Pack

AgentWeave 的 Runtime、Event、Task、Session、Inbox、Policy、Approval 和 Worker 模型必须保持领域中立。Hive 中的 Agent 可以属于软件开发、研究、内容生产、运营、数据分析或其他专业领域。

Use-Case Flavor（也称 Domain Pack）是一个可配置的领域启动模板，定义默认 Role Template、权限等级、Agent 实例、Task、Workflow、Artifact、Review、Approval、预算、安全 Policy，以及领域特定的质量门槛和 Self-Retro 结构。它也可以定义 Role Replication 的默认并发和扩容限制。

Flavor 只负责初始化和约束默认行为，不改变 Runtime 的通用协议。Human 可以在创建 Workstream 时选择 Flavor，也可以在 Workstream 内调整角色、Policy 和 Workflow。未知或自定义 Flavor 必须通过版本化配置加载，并保留完整审计记录。

## 5. Human 的角色

Human 可以：

- 向任意 Agent 发送消息；
- 广播给全部 Agent；
- 修改目标、范围或优先级；
- 请求 Agent 解释决策；
- 暂停或取消单个 Agent Run；
- 暂停和恢复整个 Workstream；
- 重新分配任务；
- 批准或拒绝高风险操作；
- 将 Workstream 标记为完成；
- 重开已完成 Workstream；
- 查看完整事件历史和任务依赖。

Human 指令优先于普通 Agent 消息，但不能自动绕过安全策略。

## 6. MVP 范围

### 6.1 成功标准

```text
创建 Workstream
→ Human 描述目标
→ 第一段 Session 成为 PM
→ 自动创建 PE、Coder、QA
→ PM 创建并分配任务
→ PE 提供设计
→ Coder 修改代码
→ QA 测试和审查
→ Human 随时与任意 Agent 对话
→ Human 暂停整个 Workstream
→ 重启所有 Docker 服务
→ Human 恢复 Workstream
→ Agents 从持久化状态继续
→ Human 将 Workstream 标记完成
```

### 6.2 MVP 部署

```text
Docker Compose
├── Dashboard
├── Control API
├── Scheduler
├── Projector
├── NATS JetStream
├── PostgreSQL
├── PM Worker
├── PE Worker
├── Coder Worker
└── QA Worker
```

所有组件通过 Docker 管理。Repository 和 Git Worktrees 通过显式 Volume 挂载给 Worker。

### 6.3 默认团队

- MVP 的默认 Flavor 是 `software-development`，默认团队为 PM、PE、Coder 和 QA Reviewer。
- 该 Flavor 支持固定的 PM → PE → Coder → QA 主流程，并允许 Human 审批后的同角色扩容和并行任务。
- MVP 聚焦软件开发，不要求研究、内容、运营或其他领域 Flavor 完成生产级交付，但 Runtime 必须保留扩展能力。

角色配置不能硬编码在领域模型中，默认团队应通过 Flavor 模板创建。

### 6.4 MVP AI Tool Adapter

MVP 先使用 Deterministic Mock Adapter 完成 E2E 验证。AI Execution Gateway 通过统一的 AI Tool Adapter 接口支持创建或恢复 Session、发送 Turn、订阅流式事件、取消 Run 和保存 Provider Session ID。Codex App Server、Claude Code 以及其他 AI 工具都通过独立 Adapter 接入，Control Plane 不依赖任何单一工具。

AgentWeave Dashboard 是主要控制界面。官方 Codex GUI 仅作为可选 companion，不作为自动化和可恢复性的依赖。

### 6.5 MVP 非目标

- Kubernetes 和多区域部署；
- 多租户 SaaS；
- 企业 SSO 和完整 RBAC；
- Claude Code、OpenHands 和 Local LLM Adapter；
- GPU 调度和自动扩缩容；
- Agent Marketplace；
- 完整可视化 Workflow Editor；
- Exactly-once 消息语义；
- 自动 Merge、Deploy 或生产环境修改。

## 7. 系统架构

完整彩色 Mermaid 架构图保存在 docs/architecture.mmd。该图明确 Dashboard 是 Control Plane 的操作入口，Workstream 内的 Agent Hive / Weave 支持 Human、PM、PE、Coder、QA 之间的任意方向通信。Worker 是可扩展的 Runtime 进程池，不等于 Agent；Agent Runtime Actor 负责绑定 durable session、inbox、lease 和 Provider Adapter。Provider Adapter 可以连接 Mock、Codex、Claude、local model 或未来的其他 AI 工具。Workspace Boundary 负责把授权项目挂载给 Provider、收集 git diff、测试结果和 evidence，而不是由 AgentWeave 自己实现代码修改。扩容只能经过 Dashboard 的 Human approval。

```text
┌──────────────────────────────────────────┐
│              React Dashboard             │
│ Chat · Tasks · Agents · Graph · Controls │
└───────────────────┬──────────────────────┘
                    │ HTTP / WebSocket
┌───────────────────▼──────────────────────┐
│            AgentWeave Control API         │
│ Workstreams · Commands · Queries          │
└──────────┬─────────────────────┬──────────┘
           │                     │
┌──────────▼─────────┐  ┌────────▼─────────┐
│ Orchestration Core │  │ Policy Engine    │
│ Scheduler / Loops  │  │ Approval / ACL   │
└──────────┬─────────┘  └────────┬─────────┘
           │                     │
┌──────────▼─────────────────────▼──────────┐
│              NATS JetStream               │
│ Events · Inboxes · Commands · Responses   │
└──────────┬─────────────────────┬──────────┘
           │                     │
┌──────────▼─────────┐  ┌────────▼─────────┐
│ Agent Workers      │  │ Projectors       │
│ PM / PE / Code / QA│  │ Event → DB Views │
└──────────┬─────────┘  └────────┬─────────┘
           │                     │
┌──────────▼─────────┐  ┌────────▼─────────┐
│ Codex App Server   │  │ PostgreSQL       │
│ Threads / Turns    │  │ Queryable State  │
└──────────┬─────────┘  └──────────────────┘
           │
┌──────────▼────────────────────────────────┐
│ Git Worktrees · Shell · Tests · Artifacts │
└───────────────────────────────────────────┘
```

### 7.1 Control Plane

负责 Workstream 生命周期、Agent 和 Session 注册、任务调度、消息路由、Human Commands、Policy、Approval、Worker Heartbeat、Retry、Recovery 和 Event Projection。

### 7.2 Execution Plane

负责 Codex Session、Agent Turn、Shell/Git/Test、Worktree、运行输出、Artifacts、Pause Ack 和 Checkpoint。

### 7.3 核心分离原则

Control Plane 不依赖具体模型。它只关心 Agent 身份、能力、任务、运行位置和结果。Codex、Claude、Qwen 或其他模型由 Provider Adapter 处理。

## 8. 技术栈

### 8.1 Monorepo

- pnpm
- Turborepo
- TypeScript

### 8.2 Backend

- Node.js
- TypeScript
- Fastify
- Zod
- WebSocket
- Pino

### 8.3 Dashboard

- React
- Vite
- TanStack Router
- TanStack Query
- Zustand
- React Flow
- Tailwind CSS
- shadcn/ui

### 8.4 Storage 与 Messaging

- PostgreSQL
- Drizzle ORM
- NATS JetStream

### 8.5 Testing

- Vitest
- Testcontainers
- Playwright

## 9. Monorepo 模块

```text
agentweave/
├── apps/
│   ├── dashboard/
│   ├── control-api/
│   ├── scheduler/
│   ├── projector/
│   └── worker/
├── packages/
│   ├── protocol/
│   ├── domain/
│   ├── event-bus/
│   ├── persistence/
│   ├── orchestration/
│   ├── policy/
│   ├── provider-codex/
│   ├── worker-runtime/
│   ├── workspace/
│   ├── observability/
│   └── config/
├── roles/
│   ├── pm.md
│   ├── pe.md
│   ├── coder.md
│   └── qa-reviewer.md
├── deployments/
│   └── docker-compose/
├── docs/
│   ├── PRODUCT_SPEC.md
│   ├── architecture.md
│   ├── protocol.md
│   ├── event-catalog.md
│   ├── security.md
│   └── development.md
└── examples/
    └── sample-project/
```

## 10. 模块职责

### 10.1 Protocol

定义 Event Envelope、Agent Message、Worker Registration、Task Assignment、Run Command、Heartbeat、Artifact Metadata、Error Code 和 Schema Version。不得依赖数据库、NATS 或 Codex。

### 10.2 Domain

定义 Workstream、Agent、Session、Task、Run、Approval、Artifact、Worker 和 Message，以及它们的状态转换规则。

### 10.3 Event Bus

提供 Provider-neutral 接口，第一实现为 `NatsJetStreamEventBus`，未来可替换为 Kafka、Redis Streams 或内存实现。

### 10.4 Persistence

负责 PostgreSQL Schema、Migration、Repository、Transaction、Projection Checkpoint、Idempotency 和 Query Model。

### 10.5 Orchestration

负责 Workstream Bootstrap、默认角色生成、Task Routing、Agent Wake-up、Retry、Recovery、Pause、Resume、Complete、Worker Selection、Role Replication 和并行任务调度。Orchestrator 必须区分逻辑 Agent 数量与 Worker 数量，并为每个任务维护 owner、lease、并发约束和冲突状态。

### 10.6 Policy

负责工具权限、Repository 范围、Network Access、Human Approval、Destructive Action Gate、Model Allowlist、Budget 和 Max Iterations。

### 10.7 AI Execution Gateway 与 Tool Adapters

AI Execution Gateway 负责 provider-neutral 的 Session、Turn、stream、cancel 和 recovery 生命周期。每个 AI Tool Adapter 将具体工具的会话和事件模型转换为 AgentWeave Event，并保存对应的 Provider Session ID。

首批 Adapter 包括 Deterministic Mock、Codex App Server 和 Claude Code；未来可接入其他 CLI、IDE Agent、模型 API 或本地运行时。工具适配器不能把工具特有的 Thread、CLI 或模型类型泄漏到 Domain 和 Control Plane。

### 10.8 Worker Runtime

负责 Worker 注册、Heartbeat、Inbox 消费、Task Lease、Provider 调用、Event 发布、Pause Ack、Checkpoint、Graceful Shutdown 和 Crash Recovery。

### 10.9 Workspace

负责 Repository 注册、Git Worktree、Branch Lease、Commit Metadata、Dirty State、Artifact 路径和恢复策略。

### 10.10 Projector

把不可变 Event Stream 投影成 Dashboard 可查询的 Workstream、Agent、Session、Task、Graph 和 Approval 视图。

### 10.11 Dashboard

提供 Workstream 创建、Goal Chat、Agent Chat、Activity Feed、Agent Graph、Task Graph、Human Steering、Pause/Resume/Complete、Approval Queue 和 Artifact Viewer。

## 11. Workstream 启动

Dashboard 的 `New Workstream` 表单包含：

- Name；
- Repository；
- Goal；
- Default Team；
- Model Configuration；
- Tool Permissions。

启动流程：

```text
创建 Workstream
→ 保存 Goal
→ 注册 Human
→ 创建 PM Agent 与 Session
→ 向 PM 发送 Goal
→ 创建 PE、Coder、QA Agent 与 Session
→ Workstream 进入 active
→ PM 开始第一次 Turn
```

关键事件：

```text
workstream.created
human.registered
agent.registered
session.created
goal.submitted
workstream.started
run.started
```

## 12. Event Bus 设计

### 12.1 Event Envelope

```ts
interface AgentWeaveEvent<TPayload = unknown> {
  eventId: string;
  eventType: string;
  schemaVersion: number;
  workstreamId: string;
  taskId?: string;
  sessionId?: string;
  runId?: string;
  actor: {
    type: "human" | "agent" | "worker" | "system";
    id: string;
    role?: string;
  };
  recipients?: Array<{
    type: "human" | "agent" | "role" | "workstream";
    id: string;
  }>;
  correlationId: string;
  causationId?: string;
  sequence: number;
  occurredAt: string;
  payload: TPayload;
}
```

### 12.2 NATS Subjects

```text
aw.workstream.{workstreamId}.events
aw.workstream.{workstreamId}.commands
aw.workstream.{workstreamId}.human
aw.agent.{agentId}.inbox
aw.session.{sessionId}.events
aw.task.{taskId}.events
aw.worker.{workerId}.commands
aw.system.workers
aw.system.dead-letter
```

### 12.3 Delivery Semantics

采用 At-least-once delivery。Consumer 使用 `consumer_id + event_id` 做幂等去重，只有业务处理和结果记录成功后才 ACK。

建议重试：

```text
第一次失败：5 秒
第二次失败：30 秒
第三次失败：2 分钟
第四次失败：10 分钟
超过限制：Dead Letter
```

基础设施错误可以 Retry；任务定义不完整应进入 Blocked；权限问题进入 Waiting for Human；测试失败发布 Review Failed。

## 13. Pause、Resume 与 Complete

### 13.1 Pause

Human 发出 `workstream.pause.requested`：

1. Workstream 进入 `pausing`；
2. Scheduler 停止分配新任务；
3. 向所有 Worker 发送 Pause Command；
4. Active Run 到达安全点后创建 Checkpoint；
5. 保存 Task、Session、Provider Thread、Git 和 Event Sequence；
6. 全部 Agent Ack 后进入 `paused`。

### 13.2 Resume

Human 发出 `workstream.resume.requested`：

1. Workstream 进入 `resuming`；
2. 验证 NATS、PostgreSQL、Repository 和 Worker；
3. 恢复 Session 和 Worktree；
4. 从最后 Sequence 继续消费；
5. 重新投递未 ACK 消息；
6. PM 收到 Resume Summary；
7. Workstream 进入 `active`。

### 13.3 Complete

Human 点击 `Mark Done` 后进入 `completing`，系统检查 Running Tasks、Pending Approvals、未提交修改、Failed Reviews、Blockers 和 QA 状态，并生成 Completion Report。

Human 可以选择：

- Complete；
- Complete Anyway；
- Return to Active；
- Cancel Completion。

Completed 表示停止自治工作并保留只读历史，不代表删除。Workstream 可以 Reopen。

## 14. Agent Chat 与 Human Steering

每个 Agent 拥有独立 Chat。Human 可以发送普通消息、Direction、Priority Change、Pause、Resume、Cancel、Request Explanation、Approve 和 Reject。

```text
Human 输入
→ API 写入 Event
→ NATS Agent Inbox
→ Worker 接收
→ 注入 Codex Session
→ Codex 响应
→ Event Bus
→ Dashboard 实时显示
```

普通消息可以排队；高优先级 Steering 可以请求 Interrupt；Cancel 终止当前 Run；Pause 等待安全检查点。

## 15. 默认角色契约

### 15.1 PM

- 理解 Human Goal；
- 识别不清楚的要求；
- 创建计划和任务；
- 分配给 PE、Coder 和 QA；
- 管理依赖和阻塞；
- 汇总进度；
- 没有 QA 证据时不得宣称完成；
- 产品决策必须询问 Human。

### 15.2 PE

- 技术设计；
- 接口与数据模型定义；
- 风险识别；
- 技术任务拆分；
- Review Coder 的技术方向；
- 对关键架构变化请求确认。

### 15.3 Coder

- 只执行分配的 Task；
- 在指定 Worktree 工作；
- 修改代码并运行测试；
- 记录变更；
- 报告失败和未完成项；
- 不自行扩大产品范围。

### 15.4 QA Reviewer

- 按 Acceptance Criteria 验证；
- 检查代码和测试；
- 运行回归测试；
- 发布 `review.passed` 或 `review.failed`；
- 提供失败证据；
- 不因 Coder 自称完成而自动通过。

## 16. 数据库核心表

```text
workstreams
agents
sessions
workers
tasks
task_dependencies
runs
events
messages
artifacts
approvals
processed_events
projection_checkpoints
workspaces
worktrees
```

关键约束：

- Event ID 全局唯一；
- Workstream Sequence 单调递增；
- Agent 在 Workstream 中有唯一身份；
- Session 对应一个 Agent；
- Provider Thread ID 建立后必须唯一；
- Task 状态通过 Domain Service 转换；
- Processed Event 通过 Consumer ID 和 Event ID 去重。

## 17. Resilience 要求

### 17.1 Worker Crash

消息 Lease 到期后重新投递，新 Worker 通过幂等记录恢复，不重复执行已确认操作。

### 17.2 Control API Restart

Workstream 状态保存在 PostgreSQL，Events 保存在 JetStream，Dashboard 重连后补齐事件。

### 17.3 NATS Restart

JetStream 使用持久化 Volume，Stream 和 Consumer 状态必须恢复。

### 17.4 PostgreSQL Restart

Projector 从最后 Projection Checkpoint 继续。

### 17.5 Codex Session Failure

Run 标记为 Interrupted，Session 保留 Provider Thread ID，Worker 重连后 Resume。

### 17.6 Duplicate Delivery

重复 `task.assigned` 不得重复创建 Worktree、Commit 或执行不可逆操作。

## 18. 安全模型

- Dashboard 默认只监听 localhost，或要求登录 Token；
- Worker 使用独立身份；
- NATS 启用认证；
- PostgreSQL 不暴露公网；
- Repository 必须显式注册；
- Worker 不能访问未挂载目录；
- Secret 不进入 Event Payload；
- 日志对 Token 和 Credential 脱敏；
- 高风险命令进入 Approval；
- Worktree 与主分支隔离；
- 默认不自动 Merge 和 Deploy。

## 19. Dashboard 页面

### 19.1 Workstream List

展示 Name、Repository、Status、Last Activity、Active Agents、Blockers 和 Human Attention。

### 19.2 Workstream Overview

展示 Goal、Progress、Agent Status、Task Summary、Latest Events 和 Pause/Resume/Complete Controls。

### 19.3 Agent Chat

展示 Agent Role、Session Status、当前 Task、Chat Timeline、Tool Activity、Human Input 和 Pause/Cancel Controls。

### 19.4 Network Graph

节点包括 Human、Agents、Tasks 和 Artifacts；边表示 Message、Assignment、Review、Dependency 和 Approval。

### 19.5 Task Board

```text
backlog
ready
assigned
running
blocked
review
done
cancelled
```

### 19.6 Activity Feed

展示所有 Workstream Events，并支持按 Agent、Task、Event Type、Human、Error 和 Approval 过滤。

## 20. 实施计划

### Phase 0：项目基础

- 创建 Monorepo；
- 初始化 Git、pnpm、Turborepo 和 TypeScript；
- 配置 ESLint、Prettier 和 Vitest；
- 建立 Docker Compose；
- 启动 PostgreSQL 和 NATS；
- 建立 CI 和文档目录。

验收：`pnpm install`、`pnpm lint`、`pnpm test` 和 `docker compose up` 成功。

### Phase 1：Protocol 与 Domain

- 定义 ID、Event Envelope 和 Command；
- 定义 Workstream、Agent、Session、Task 和 Run；
- 定义状态机、Error 和 Schema Version；
- 编写 Contract Tests 和状态转换测试。

### Phase 2：Persistence

- 建立 Drizzle Schema 和 Migration；
- 实现 Repository 与 Transaction；
- 建立 Projection、Checkpoint 和 Idempotency；
- 编写 PostgreSQL Integration Tests。

### Phase 3：NATS Event Bus

- 初始化 JetStream；
- 实现 Publish、Pull Consumer、Ack、Retry、Dead Letter 和 Replay；
- 实现断线恢复和 Consumer Lag Metrics；
- 测试离线保留、Crash Redelivery 和重复消息。

### Phase 4：Workstream Control API

实现：

```text
POST /workstreams
POST /workstreams/:id/start
POST /workstreams/:id/pause
POST /workstreams/:id/resume
POST /workstreams/:id/complete
POST /workstreams/:id/reopen
GET  /workstreams
GET  /workstreams/:id
GET  /workstreams/:id/events
```

所有命令必须生成 Event，支持幂等，并在 API 重启后保留状态。

#### Message API 与实时 Dashboard 通道

HTTP API 是可靠的命令与查询入口，WebSocket 是低延迟的实时通知入口；两者不互相替代。

```text
POST /api/workstreams/:id/messages                         发送消息
GET  /api/workstreams/:id/messages                         查询 Workstream 消息历史
GET  /api/workstreams/:id/agents/:agentId/inbox            查询 Agent Inbox
POST /api/workstreams/:id/messages/:messageId/ack         确认投递
POST /api/workstreams/:id/messages/:messageId/fail        报告投递失败
POST /api/workstreams/:id/messages/:messageId/reply       创建回复
GET  /events                                               WebSocket 实时事件
```

消息先写入 PostgreSQL，再通过 WebSocket 发布 `message.created`、`message.delivered`、`message.acknowledged`、`message.failed` 和 `message.reply.created`。Dashboard 首次加载通过 HTTP 获取历史，保持 WebSocket 接收增量；断线重连后使用最后一个消息 ID 或时间游标通过 HTTP 补齐，不能把 WebSocket 当作唯一事实来源。

Inbox 按具体 `agentId` 隔离。多收件人消息在逻辑上只有一个 Message，但每个收件人拥有独立投递状态；重复投递必须通过 Message ID / consumer key 幂等处理，不能重复产生领域副作用。

### Phase 5：Worker Runtime

- Worker Registration 和 Heartbeat；
- Capability Advertisement；
- Inbox Consumer 和 Task Lease；
- Graceful Shutdown、Pause、Resume 和 Checkpoint；
- 使用 Mock Provider 完成多 Agent 通信和 Crash Recovery。

### Phase 6：AI Tool Adapters

- AI Execution Gateway；
- Codex App Server Adapter；
- Claude Code Adapter；
- other AI tool adapters;
- Thread Start、Resume 和 Fork；
- Turn Start 和 Event Streaming；
- Cancel、Reconnect 和 Event Mapping；
- Role Instructions 和 Human Message Injection。

验收：创建四个独立 Codex Sessions，Human 可向任意 Session 发消息，输出实时进入 Event Bus，断开后可恢复。

### Phase 7：Worktree 与 Artifacts

- Repository Registration；
- Worktree 和 Branch Lease；
- Commit、Diff 和 Test Artifact；
- Dirty State、Recovery 和 Cleanup Policy。

### Phase 8：Dashboard 基础

- Workstream List 和 New Workstream；
- Goal Input 和 Overview；
- Agent Tabs 和 Chat；
- Activity Feed；
- Pause、Resume、Complete；
- WebSocket Live Events 和 Reconnect Catch-up。
- HTTP 历史消息 + WebSocket 增量消息的双通道体验；Agent 节点、边和 Human Chat 使用不同过滤视图。

### Phase 9：Tasks 与 Graph

- Task Board；
- Dependency Graph；
- Agent Network Graph；
- Message Edges、Blockers、Current Owner 和 Agent Status；
- 点击节点跳转到 Chat 或 Task。

### Phase 10：完整 E2E

```text
创建示例 Repository
→ Human 要求增加一个 API
→ PM 分解
→ PE 设计
→ Coder 实现
→ QA 测试
→ Human 中途 Pause
→ Docker Compose 重启
→ Resume
→ QA 通过
→ Human Mark Done
```

必须证明无状态丢失、无重复不可逆操作、所有 Chat 可回看、所有 Event 可审计、最终代码和测试有效。

## 21. 未来扩展

### 21.1 Distributed Worker Cluster

- Remote Registration；
- mTLS 和 Node Identity；
- Capacity Scheduling；
- Worker Labels；
- Network Policy；
- Artifact Transfer；
- Remote Workspace；
- Failure Reassignment；
- Kubernetes 或 Nomad Deployment。

### 21.2 多模型支持

Provider 可扩展至：

- Claude Code；
- OpenHands；
- Qwen；
- Ollama；
- vLLM；
- OpenAI API；
- Anthropic API；
- OpenAI-compatible API。

每个 Agent 可以独立选择模型和计算节点。例如 PM 使用高能力云模型、Coder 使用本地 Qwen、QA 使用另一模型独立验证。

### 21.3 Model Router

根据角色、任务难度、成本、延迟、隐私、GPU、Context Length 和历史质量自动选择模型。

### 21.4 Dynamic Teams

PM 可以申请 Security Reviewer、Database Expert、Frontend Coder、Researcher 或 Release Manager，Human 可批准或拒绝扩容。

### 21.5 Role Replication 与弹性扩容

在默认团队之外，Runtime 可以按需复制已有角色，例如创建多个 Coder 或 Researcher Agent Instance。复制后的 Agent 共享 Role Template，但拥有独立 Session、Inbox、Run 历史和 Workspace。调度器根据 Ready Task 数量、依赖关系、预算、Worker 容量和冲突风险决定排队、复用或扩容。

扩容策略必须是有界且可观测的：每个 Workstream 和 Role 都可配置最大并发数、最大实例数、空闲回收时间和预算保护。每次扩容先产生面向 Human 的 Recommendation，只有带有对应 Approval Event 的 Recommendation 才能执行。扩容不能绕过工具权限、Workspace 隔离或 Token Budget。多个 Agent 的结果必须通过任务证据、Artifact 和 QA 汇总；不能因为并行而直接覆盖彼此的工作。

该能力不是 MVP 的默认行为。MVP 先支持固定四角色和串行主流程，但协议、任务模型、Inbox、Worker Selection 和事件类型必须保留 `agentInstanceId`、owner、lease 和并发字段，以便后续启用同角色并行执行。

### 21.6 Enterprise Control Plane

未来可增加 Multi-user、Organization、RBAC、SSO、Audit Export、Secrets Management、Policy as Code、Cost Controls 和 Private Networking。

### 21.7 Federation

多个 AgentWeave Cluster 通过受控协议共享有限 Agent 能力，而不暴露完整内部数据。

## 22. 开源边界

建议开源：

- Protocol；
- Runtime；
- Event Bus Integration；
- Workstream Engine；
- AI Tool Adapter contracts and adapters；
- Dashboard；
- Docker Compose；
- Worker SDK；
- Local Deployment。

当前首要目标不是商业化，而是：

> 让 AgentWeave 在真实项目中可靠、持久、可恢复地工作。

## 23. Skill 系统与运行时动态关联

Skill 是 AgentWeave 的一等资源，而不是一段临时附加到 Prompt 的文本。用户可以把 Skill 关联到不同范围：

```text
Global Skill
Workstream Skill
Role Skill
Agent Skill
Task Skill
```

Agent 的有效 Skill 集为：

```text
Effective Skills
= Global
+ Workstream
+ Role
+ Agent
+ Task
```

### 23.1 Skill 数据模型

```ts
interface SkillDefinition {
  skillId: string;
  name: string;
  version: string;
  description: string;
  source:
    | { type: "filesystem"; path: string }
    | { type: "git"; repository: string; revision: string }
    | { type: "registry"; package: string; version: string }
    | { type: "inline"; content: string };
  requiredTools: string[];
  requiredSecrets: string[];
  compatibleProviders: string[];
  checksum: string;
}

interface SkillAssignment {
  assignmentId: string;
  skillId: string;
  skillVersion: string;
  targetType: "global" | "workstream" | "role" | "agent" | "task";
  targetId: string;
  enabled: boolean;
  priority: number;
  assignedBy: string;
  assignedAt: string;
}
```

Skill 必须固定版本和 Checksum，避免 Workstream 执行过程中 Skill 内容被静默替换，导致运行不可重放。

### 23.2 运行中添加 Skill

用户可以在 Workstream 进行过程中添加、删除、禁用或升级 Skill。

默认应用流程：

```text
skill.assignment.requested
→ skill.validated
→ agent.skill_update.pending
→ 当前 Run 到达安全点
→ Skill Set 更新
→ Session 更新或重建
→ agent.skill_update.applied
```

如果 Agent 空闲，Skill 可以立即生效。如果 Agent 正在执行任务，默认从下一个 Run 生效。Human 可以选择立即应用，此时系统需要先暂停当前 Run、建立 Checkpoint，再使用新的 Skill Set 恢复。

Skill 的作用范围可以是：

- Future work only；
- Current task；
- Current task and previous output review；
- Entire workstream。

如果 Provider 支持原生 Skill，则 Adapter 使用原生机制；否则将 Skill 映射为 Developer Instructions、受控上下文文件、MCP Tools、CLI Tools 或 Runtime Hooks。

### 23.3 分布式 Skill

本地文件路径不能作为分布式系统中的稳定 Skill 标识。未来 Cluster 模式需要 Skill Registry：

```text
Skill Registry
→ Worker 下载指定版本
→ 校验 Checksum / Signature
→ 解压到隔离目录
→ 仅挂载给指定 Agent Run
```

MVP 支持 Filesystem 和 Inline Skill；后续增加 Git、OCI Artifact 和 AgentWeave Registry。

Skill 被视为可执行依赖，必须声明权限、隔离运行、保护 Secret，并完整记录审计事件。

## 24. Self-Retro 与阶段性记忆（Post-MVP）

AgentWeave 未来应具备完整 Workstream Self-Retro 能力：基于真实事件、任务、代码产物和 Agent 状态，生成可恢复、可追踪、可行动的阶段性反思。完整 Self-Retro 不阻塞 Day 1 和 MVP。

Retro 必须回答：

- 原始目标及后续 Goal 变化；
- 已完成、进行中、阻塞和取消的任务；
- 已验证结果与未验证声明；
- Human 的关键决策；
- 架构偏离和技术债；
- Git、测试和 QA 状态；
- Agent 健康、失败和资源使用；
- 当前风险、阻塞和下一阶段建议。

Retro 不能只依赖聊天记忆，而应基于：

```text
Event History
Tasks and Dependencies
Agent Sessions
Human Decisions
Git Commits and Diffs
Test Results
QA Reviews
Approvals and Blockers
Worker Failures
Cost and Token Usage
```

### 24.1 Retro 触发方式

- Human 手动触发；
- Milestone 完成；
- Pause 之前；
- Resume 之后；
- Goal 发生变化；
- QA 连续失败；
- 多个任务阻塞；
- Skill 或团队发生重大变化；
- Completion 之前。

### 24.2 Retro 一致性

Retro 开始时记录 `from_sequence` 和 `cutoff_sequence`。Retro 只总结这个固定 Event 区间，避免生成过程中不断出现的新事件导致结论不一致。

推荐流程：

```text
retro.requested
→ 冻结 Retro Event 范围
→ 收集任务、代码、测试和决策事实
→ PM / PE / Coder / QA 分别提交角色报告
→ PM 汇总 Retro Draft
→ QA 检查事实一致性
→ Human 查看、修改或确认
→ retro.completed
```

### 24.3 事实等级

Retro 必须区分：

- Verified Fact：有 Event、Commit、Test 或 Human Decision 支持；
- Agent Report：Agent 的报告，但尚未独立验证；
- Inference：根据证据作出的推断；
- Recommendation：对后续工作的建议。

Retro 可以提出创建任务、调整优先级、关联 Skill、增加 Reviewer 或更换模型等建议，但不能静默修改 Workstream。建议必须转换成显式 Command，并由 Human 或授权 PM 确认。

### 24.4 Retro 作为长期记忆

```text
Raw Event Log
  完整、不可变、永久保留

Approved Retros
  稳定的阶段性长期记忆

Agent Runtime Context
  Goal + 最近 Retro + Human Decisions + 当前 Task + 相关 Artifacts
```

这套结构用于控制 Context Window，并让长时间暂停后的 Agent 快速恢复。

### 24.5 P0 Workstream Summary Report So Far

P0 不实现多 Agent Self-Retro，但必须支持轻量、可靠、随时可生成的 `Summary Report So Far`。

Summary Report 主要由 Projector 基于结构化状态生成，不依赖 Agent 聊天记忆，也不要求多个 Agent 额外讨论。它必须包含：

- Workstream Goal 和当前 Status；
- 已完成、进行中、阻塞和失败的 Task；
- 每个 Agent 的状态和当前 Task；
- Human Decisions；
- 最新 Commit 和 Artifact；
- QA 验证状态；
- 当前 Error 和 Blocker；
- 下一步 Action；
- 总 Token Usage 及按 Agent、Task 的统计；
- 报告覆盖到的 Event Sequence。

```ts
interface WorkstreamSummary {
  workstreamId: string;
  generatedAt: string;
  throughSequence: number;
  goal: string;
  status: WorkstreamStatus;
  progress: {
    totalTasks: number;
    completedTasks: number;
    activeTasks: number;
    blockedTasks: number;
    failedTasks: number;
  };
  agents: AgentProgressSummary[];
  completedWork: SummaryItem[];
  activeWork: SummaryItem[];
  blockers: SummaryItem[];
  humanDecisions: DecisionReference[];
  artifacts: ArtifactReference[];
  qaStatus: QAStatusSummary;
  errors: ErrorSummary[];
  tokenUsage: TokenUsageSummary;
  nextActions: SummaryItem[];
}
```

Dashboard 一直显示确定性的 Live Summary。Human 可以点击 `Summarize progress so far`，让 PM 基于固定 Summary Snapshot 使用一次可选 LLM Run 生成简短 Narrative Summary。PM 必须引用 Snapshot 中的 Task、Event、Commit、Test 和 Decision，不能只根据聊天记忆总结。

P0 触发点：

- Human 手动请求；
- PM 请求 Human Review；
- Pause 之前；
- Complete 之前。

Pause 保存 Machine Checkpoint 和 Workstream Summary；Resume 时 Agent 接收 Goal、Summary、Current Task、Relevant Decisions、Queued Messages 和最新 Repository State。完整的多 Agent Self-Retro、偏差分析和改进建议放到 Post-MVP。

## 25. 持续观察、主动 Insight 与 Agent Autonomy

AgentWeave 不是简单的线性 Multi-Agent Workflow。Agent 是长期存在、可观察、可主动行动的网络节点。

核心原则：

> Agent 逻辑上持续在线，但 LLM 不持续无条件运行。

```text
Agent Session：长期持久化
Agent Inbox：持续接收事件
Observer：持续监听，低成本运行
LLM Run：满足 Wake-up 条件时启动
```

### 25.1 Agent 行为模式

- Reactive：收到 Task、Message、Review 或 Human Command 后执行；
- Observational：持续观察相关事件并更新 Awareness；
- Proactive：根据新证据主动产生 Insight、Proposal、Risk 或 Question。

Agent 状态：

```text
registered
idle
observing
thinking
acting
waiting
paused
offline
```

Idle 表示当前无需调用模型，不代表 Agent Session 不存在。

### 25.2 默认观察范围

PM 订阅 Task、Blocker、Review、Agent Health、Budget、Human Message 和 Retro。

PE 订阅 Architecture、Interface、Dependency、Technical Decision、关键 Diff 和技术债。

Coder 订阅 Assigned Task、Technical Design、Review Feedback、相关文件变更和 Human Direction。

QA 订阅 Acceptance Criteria、Commit、Artifact、Task Completion、Test Result 和跨任务冲突。

QA 不需要等待 PM 明确派发每一次 Review。新 Commit 或 Artifact 可以触发 QA 自动建立 Review Intent。PM 也可以根据阻塞、失败、并发机会和成本主动重新规划。

### 25.3 Agent Insight

Agent 之间使用结构化 Insight，而不仅是自由 Chat：

```ts
interface AgentInsight {
  insightId: string;
  workstreamId: string;
  authorAgentId: string;
  target:
    | { type: "agent"; id: string }
    | { type: "task"; id: string }
    | { type: "artifact"; id: string }
    | { type: "workstream" };
  category:
    | "risk"
    | "opportunity"
    | "contradiction"
    | "dependency"
    | "quality"
    | "architecture"
    | "scope"
    | "performance";
  confidence: number;
  evidence: EvidenceReference[];
  message: string;
  proposedActions: ProposedAction[];
  status: "open" | "acknowledged" | "accepted" | "rejected" | "resolved";
}
```

Insight 必须尽量附带 Event、Task、Artifact、Commit、Test 或 Decision Evidence。Agent 可以 Acknowledge、Accept、Challenge 或 Reject，并提供依据。

Agent 之间共享的是明确消息、计划、Decision、Evidence、Artifact、Review、Reasoning Summary、Assumption 和 Risk，而不是隐藏 Chain of Thought。

### 25.4 Shared Awareness Layer

Agent 不直接加载全部原始事件：

```text
Raw Event Stream
→ Projectors / Indexers
→ Agent-specific Observations
→ Relevance Filter
→ Wake-up Decision
→ Agent Run
```

Agent 可以 Watch Task、Package、Artifact 或其他 Agent。不同角色拥有不同的默认相关性过滤器。

### 25.5 Wake-up Policy

```yaml
agent: qa-reviewer
subscriptions:
  - artifact.created
  - commit.created
  - task.completed
  - acceptance_criteria.changed
  - test.failed
wake_when:
  - relevant_task_changed
  - unreviewed_artifact_created
  - cross_task_conflict_detected
  - periodic_review_due
cooldown: 60s
max_proactive_runs_per_hour: 10
deduplication_window: 30m
```

### 25.6 防止无限 Agent Loop

必须实现：

- Causation Chain；
- 最大 Agent-to-Agent Depth；
- Insight 和 Message Deduplication；
- Cooldown；
- 每小时 Proactive Run 限制；
- Token 和 Cost Budget；
- 无新 Evidence 时禁止重复提出；
- Conversation Circuit Breaker；
- Human Attention Threshold。

如果同一 Correlation Chain 触发多次 Agent Run 且没有新的 Task、Artifact、Commit、Test 或 Human Event，系统必须暂停该链并请求 Human。

## 26. Human Control、PM Review Gate 与停止语义

Human 拥有最高控制权。系统区分以下控制操作：

### 26.1 Stop Run

停止当前模型调用或工具执行，保留 Agent Session、已产生的文件和事件，Agent 回到 Idle 或 Interrupted。

### 26.2 Pause Agent

停止指定 Agent 接收和执行新任务，其他 Agent 可以继续。消息仍可进入该 Agent 的 Durable Inbox。

### 26.3 Pause Workstream

停止任务调度，通知所有 Agent 到安全点，创建 Checkpoint 和 Retro，所有 Agent 进入 Paused。

### 26.4 Emergency Stop

立即取消所有 Run、撤销 Worker Lease、停止工具执行、禁止新的模型调用并保留现场。Emergency Stop 不等待 Agent 同意。

### 26.5 Waiting for Human

PM 可以评估当前状态并发布 `human_review.requested`，用于需求歧义、架构选择、Milestone Review、高风险 QA 结果、Scope 扩大、成本超限、Agent 分歧，以及 Merge、Deploy 或破坏性操作之前。

`waiting_for_human` 与 `paused` 不相同：

```text
waiting_for_human_partial
  只停止依赖当前 Human Decision 的任务，其他独立工作继续

waiting_for_human
  所有可继续工作都依赖 Human Decision，自治运行进入静止状态

paused
  Human 明确要求整个 Workstream 停止
```

Human Review Request 应包含 Summary、Questions、Options、Recommendation、Evidence 和建议 Pause Scope。

### 26.6 PM Pause Policy

```yaml
pm_pause_policy: propose | safe_pause | autonomous
```

- `propose`：PM 只能建议暂停，由 Human 确认；
- `safe_pause`：PM 可以停止新任务并让 Agent 到达安全点；
- `autonomous`：PM 可按 Policy 暂停和恢复，但 Human 可随时覆盖。

MVP 默认使用 `safe_pause`：PM 可以触发 Waiting for Human、停止新任务调度并请求安全 Checkpoint；Human 决定正式 Pause、Resume 或 Complete。

### 26.7 Pause Barrier

```text
停止发放新 Lease
→ 广播 pause.requested
→ Agent 到达安全点
→ 停止新工具调用
→ 保存 Session Cursor、Task 和 Git 状态
→ agent.pause.acknowledged
→ 创建 Progress Snapshot 和 Retro
→ Workstream 进入 paused
```

如果 Agent 超时未响应，系统可以 Cancel Active Run、Revoke Lease、标记 Interrupted，并完成 Forced Pause。

Human 的 Review 回复必须同时成为 PM Chat Message、`human.decision.recorded` Event、Workstream 长期 Decision，以及后续 Retro 和 Agent Context 的事实来源。

### 26.8 Typed Human Input

Human Input 不能只保存为无类型 Chat String。AgentWeave 必须区分 Human 是在提问、请求一次行动、创建任务、设置长期行为、控制 Runtime、作出决策，还是提供反馈。

同一句自然语言可能具有不同语义：

```text
“Validate all cases.”

Question:
  Do you currently validate all cases?

One-time request:
  Validate all cases now.

Task:
  Add and validate the missing cases, then report completion.

Directive:
  Validate all registered cases every time you review.

Policy:
  No QA review may pass unless all registered cases pass.
```

Human Input 必须包含 Intent、Scope、Lifetime 和 Expected Outcome：

```ts
interface HumanInput {
  inputId: string;
  workstreamId: string;
  target: InputTarget;
  intent:
    | "question"
    | "request"
    | "task"
    | "directive"
    | "command"
    | "decision"
    | "feedback";
  scope:
    | "message"
    | "current_run"
    | "current_task"
    | "agent"
    | "role"
    | "workstream";
  lifetime:
    | "one_time"
    | "until_task_complete"
    | "until_workstream_complete"
    | "persistent";
  requiresResponse: boolean;
  requiresAction: boolean;
  content: string;
  status:
    | "received"
    | "classified"
    | "acknowledged"
    | "applied"
    | "completed"
    | "cancelled";
}
```

#### Question

Human 只需要一次回答，不创建 Task、不改变 Policy，也不进入后续 Agent Context，除非答案产生新的显式 Decision。

#### One-time Request

执行一次具体行动，返回结果和 Evidence，然后标记 Completed，不影响未来行为。

#### Task

创建有 Owner、Status、Acceptance Criteria 和 Evidence 的可跟踪工作，生命周期持续到完成或取消。

#### Directive

改变 Agent、Role 或 Workstream 的后续行为，必须持久化，并在未来 Context Pack 中生效，直到到期、移除或 Workstream 完成。

#### Command

Pause、Resume、Stop、Cancel 和 Complete 等 Runtime 控制命令直接由 Control Plane 处理，不能依赖 Agent 自然语言解释。

#### Decision

解决一个 Open Decision，持久化为 Workstream Fact，并解除相关 Task Dependency 或 Waiting for Human 状态。

#### Feedback

记录 Human 对结果或方向的评价。如果是否需要行动不明确，系统应询问，而不是把所有评论静默转换成 Task。

### 26.9 Human Input Classification

Human Input 使用两层分类机制。

第一层是 Dashboard 显式输入模式：

```text
Ask once
Request action
Create task
Set directive
Control
```

默认模式为 `Ask once`。Human 可以主动选择更强的语义。

第二层是自然语言推断。Classifier 可以提出 Intent、Scope 和 Lifetime，但不能静默扩大 Human 指令的影响范围。

低风险的一次性 Question 或 Request 可以自动处理。以下类型必须显式确认：

- Persistent Directive；
- Workstream-wide Instruction；
- Recurring Action；
- Permission Expansion；
- Destructive Command；
- Mark Complete；
- 会中断多个 Agent 的 Control Command。

默认歧义处理规则：

```text
ambiguous question  → answer once
ambiguous request   → execute once
possible directive  → request confirmation
destructive command → explicit confirmation
```

检测到长期 Directive 时，Dashboard 显示：

```text
Detected: Persistent QA directive

Apply to: QA role
Duration: Until workstream completes

[Confirm directive]
[Send as one-time request]
[Cancel]
```

P0 必须实现 `question`、`request`、`directive`、`command` 和 `decision`。`task` 可以通过 Request 转为正式 Task；完整 Feedback Workflow 可后续增强。

### 26.10 Human Input Events

Human Input 的解释和执行必须可审计：

```text
human.input.received
human.input.classified
human.input.confirmation_requested
human.input.confirmed
human.question.answered
human.request.completed
human.directive.applied
human.directive.revoked
human.command.executed
human.decision.recorded
```

原始输入、分类结果、Human 确认、最终作用范围和执行结果都必须保留。AgentWeave 不得只保存分类后的改写文本。

## 27. Day 1 Performance 与 Optimization Budget

Performance 是 P0 非功能需求。目标不是过早追求极限吞吐，而是确保 AgentWeave 的基础设施开销显著低于 LLM 推理时间，并且 Agent 数量增加时事件系统和 Dashboard 仍保持响应。

### 27.1 Day 1 性能预算

以下指标不包含 LLM 推理时间：

| 指标 | Day 1 目标 |
|---|---:|
| REST API 本地 P95 | `< 100ms` |
| Event publish P95 | `< 20ms` |
| Event 到 Worker P95 | `< 100ms` |
| Event 到 Dashboard P95 | `< 250ms` |
| Chat 首次加载 | `< 500ms` |
| Workstream 恢复 | `< 2s` |
| Pause 命令传播 | `< 250ms` |
| 单机持续事件吞吐 | `1,000 events/s` |
| 单 Workstream Agent 数量 | 至少 `32` |
| Dashboard 同屏事件能力 | `10,000+`，不冻结 |
| 重复 Event 展示 | `0` |
| 消息丢失 | `0` |

### 27.2 热路径

```text
Producer
→ NATS JetStream
→ Worker / Projector
→ WebSocket
→ Dashboard
```

Event 不应经过多个同步 HTTP 服务。Command 写入权威状态并产生 Event，Read Model 由 Projector 异步更新。需要数据库和消息原子一致性的路径使用 Transactional Outbox，防止数据库成功但 NATS 发布失败。

### 27.3 PostgreSQL 与 Projector

核心索引从 Day 1 建立：

```text
(workstream_id, sequence)
(session_id, sequence)
(task_id, occurred_at)
(event_type, occurred_at)
(correlation_id)
```

Chat 使用专门的 Message Read Model，不扫描完整 Event JSON。Projector 批量读取 Event，并在单个 Transaction 中 Batch Upsert 和更新 Checkpoint。

### 27.4 WebSocket 与 Streaming

每个 Dashboard Workstream 使用一个 WebSocket 连接，在客户端按 Agent、Task 和 Event Type 分发，不为每个 Agent 建立独立连接。

模型 Token Stream 不作为逐 Token Event 持久化：

```text
Token Stream
→ 内存聚合 50–100ms
→ WebSocket Chunk
→ Run 完成后保存完整 Message
```

### 27.5 Payload 与 Artifact

- 普通 Event 建议 `< 64KB`；
- Chat Message 建议 `< 256KB`；
- Diff、长日志、截图和测试报告作为 Artifact 保存；
- Event 仅携带 Artifact Reference 和必要 Metadata。

### 27.6 Dashboard 性能

Dashboard 使用 Cursor Pagination、Virtualized List、按需历史加载、增量状态更新和细粒度 Selector。大型 Payload 不直接进入全局 UI State。

### 27.7 Agent Wake-up 性能

```text
NATS Subject Filter
→ Cheap Rule Filter
→ Relevance Check
→ Debounce / Observation Batch
→ LLM Wake-up
```

短时间内出现的 Commit、Test 和 Task Status Event 应合并成一个 Observation Batch，避免重复唤醒同一 Agent。

### 27.8 Observability

所有路径携带 `event_id`、`correlation_id`、`causation_id`、`workstream_id`、`agent_id` 和 `run_id`。

至少采集：

- API Latency；
- Event Publish/Delivery Latency；
- Consumer Lag；
- Projector Lag；
- WebSocket Fan-out Latency；
- PostgreSQL Query Latency；
- Agent Queue Depth；
- Active Run Count；
- Retry Count；
- CPU 和 Memory。

### 27.9 Day 1 Load Test

自动 Benchmark：

```text
创建 1 个 Workstream
注册 32 个 Agents
发布 10,000 个 Events
并发发送 1,000 条 Messages
验证顺序、丢失、重复和延迟
```

输出 Throughput、P50/P95/P99、Consumer Lag、Projection Delay、Memory、Duplicate Count 和 Missing Count。

Day 1 不引入 Rust 重写、Kafka、Redis Cache、PostgreSQL Sharding、Kubernetes Autoscaling 或自定义二进制协议。TypeScript、NATS 和 PostgreSQL 应先通过正确的热路径、索引、批处理和前端渲染满足预算。

## 28. Token Efficiency 与 Agent Conversation Governance

Token Efficiency 是 P0 约束。AgentWeave 的目标不是最大化 Agent 对话数量，而是用最少的高价值 Agent 交互，把 Goal 推进到经过验证的结果。

### 28.1 禁止无目的 Agent 对话

Agent-to-Agent Message 必须属于明确业务类型：

```text
task.assign
task.result
question
answer
insight
review.request
review.result
decision.request
decision
blocker
status
```

纯确认、Delivery ACK、Task Claim 和状态更新由 Runtime 处理，不调用 LLM。默认禁止“收到”“谢谢”“我同意”“我再总结一次”等不推进工作的模型消息。

### 28.2 Wake-up Gate

每次调用模型之前必须判断：

- 是否存在新 Evidence；
- 是否影响该 Agent 的 Role 或 Task；
- 是否确实需要该角色判断；
- 是否已有 Agent 回答；
- 是否处于 Cooldown；
- 是否超出 Run、Task、Agent 或 Workstream Budget；
- 是否可以由确定性 Runtime 完成。

不满足 Wake-up 条件时不得调用 LLM，并记录 Suppression Reason。

### 28.3 Context Pack

Agent Run 仅接收最小相关上下文：

```ts
interface ContextPack {
  roleContract: string;
  goalSummary: string;
  task: TaskContext;
  decisions: DecisionReference[];
  artifacts: ArtifactReference[];
  unresolvedMessages: Message[];
  recentFailure?: FailureContext;
  tokenBudget: number;
}
```

默认不加载完整 Workstream Chat、其他 Agent 的全部历史、无关 Task、已完成任务的原始长上下文或完整工具日志。

### 28.4 Structured Message

Agent 通过机器可读 Payload 交换 Objective、Acceptance Criteria、Evidence、Artifact Reference、Proposed Action 和 Next State。接收方不应从长篇自由文本中猜测任务状态。

示例：

```json
{
  "type": "task.assign",
  "taskId": "task_42",
  "objective": "Implement GET /health",
  "acceptanceCriteria": [
    "Returns HTTP 200",
    "Response contains status=ok",
    "Includes automated test"
  ],
  "designArtifactId": "artifact_pe_12",
  "relevantFiles": ["src/server.ts", "test/server.test.ts"]
}
```

### 28.5 Delta-based Insight

主动 Insight 必须说明：

```text
new_evidence
impact
target
proposed_action
```

没有新 Evidence 时，不允许重复发布相同观点。发送前使用 Message Type、Task、Target、Evidence IDs 和 Proposed Action 的规范化 Hash 进行去重。MVP 不额外调用 Embedding Model 做语义去重。

### 28.6 对话异常检测和 Circuit Breaker

复杂任务可能需要大量有效协作，因此 P0 不设置固定 Agent 调用次数或固定对话轮次。Runtime 根据以下信号识别异常循环：

- 相同 Correlation Chain 长时间没有新 Evidence；
- Agent 重复发送相同类型、Target 和 Proposed Action；
- Task、Artifact、Commit、Test 和 Human Decision 都没有发生变化；
- Token 消耗持续增加但 Workstream State 没有推进；
- 同一争议反复出现且没有新增依据。

触发 Circuit Breaker 后，Runtime 暂停对应 Conversation Chain，生成简短争议摘要并交给 PM；必要时进入 `waiting_for_human`。阈值可以配置，但不能作为所有复杂项目的统一硬上限。

### 28.7 Workstream 总 Token Budget

P0 只要求一个 Workstream 级总 Token Budget，不对不同角色、任务或 Run 设置固定硬配额。

```yaml
token_budget:
  total: 1000000
  soft_limit_ratio: 0.8
  hard_limit_ratio: 1.0
```

在 Soft Limit 之前正常运行并持续记录 Token Usage。达到 Soft Limit 后：

- 通知 Human；
- PM 生成 Summary Report So Far；
- 减少低优先级 Proactive Wake-up；
- 更积极地压缩 Context 和合并 Observation。

达到 Hard Limit 后：

- 不再启动新的 LLM Run；
- 允许正在进行的安全操作结束或建立 Checkpoint；
- Workstream 进入 `waiting_for_human`。

Human 可以增加 Budget、继续不限额运行、暂停 Workstream、调整模型、降低主动行为或 Mark Done。

系统仍按 Agent 和 Task 统计 Token Usage，但这些统计用于观察和优化，不是 P0 的固定配额。

### 28.8 确定性 Runtime 优先

以下工作不得默认调用 LLM：

| 工作 | 执行者 |
|---|---|
| 消息路由与 ACK | Runtime |
| Task 状态转换 | Domain Engine |
| Git Diff 获取 | Workspace Service |
| Test 结果基础解析 | Tool Adapter |
| 重复检测 | Runtime |
| Budget 计算 | Runtime |
| 基础 Wake-up 判断 | Rule Engine |
| Consumer Lag 和进度计算 | Projector |
| 规划、实现、判断和审查 | LLM Agent |

长测试日志应先由确定性解析器提取 Failed Test、Error Message、Stack Trace、相关文件和必要行，再进入 Agent Context。

### 28.9 Token Ledger

每次模型调用记录：

```text
provider
model
agent
workstream
task
run
input_tokens
output_tokens
cached_tokens
estimated_cost
wake_reason
context_pack_size
```

Dashboard P0 显示 Workstream Tokens、Tokens by Agent、Tokens by Task、Proactive vs Assigned Runs 和 Suppressed Wake-ups。

### 28.10 Day 1 Token 验收

固定 `/health` E2E Workflow：

```text
Human → PM
PM → PE
PE → PM / Coder
Coder → QA
QA → PM
PM → Human
```

必须满足：

- 没有纯确认型 LLM 消息；
- 每次模型调用都有 `wake_reason`；
- 每条主动 Insight 都有新 Evidence；
- Agent 只接收相关 Context Pack；
- Workstream 总 Budget 达到 Soft Limit 后产生通知和 Summary；
- Workstream 总 Budget 达到 Hard Limit 后自动进入 `waiting_for_human`；
- 不限制必要的有效协作次数；
- 无新 Evidence 且不推进状态的重复对话可以被 Circuit Breaker 抑制；
- Dashboard 可查看 Token Ledger 和被抑制的无效 Wake-up。

## 29. MVP Definition of Done

- Dashboard 可以创建 Workstream；
- 第一段 Chat 成为 PM；
- 自动创建 PE、Coder 和 QA；
- 四个 Agent 使用真实 Codex Session；
- Agent 可以互相发送持久化消息；
- Agent 可以根据固定订阅规则观察相关事件；
- PM、PE 和 QA 可以主动发布带 Evidence 的 Insight；
- Circuit Breaker 可以阻止无新证据的无限 Agent 对话；
- Human 可以与任意 Agent 对话；
- Human Input 保存明确的 Intent、Scope 和 Lifetime；
- Dashboard 输入框支持 Ask Once、Request Action、Set Directive 和 Control；
- 普通消息默认按一次性 Question 或 Request 处理；
- Persistent Directive 和高影响 Command 在应用前需要 Human 确认；
- Question 不会静默创建 Task 或改变 Agent 后续行为；
- Runtime Command 直接由 Control Plane 处理，不依赖 Agent 解释；
- Human 可以 Stop Run、Pause Agent、Pause Workstream 和 Emergency Stop；
- PM 可以触发 Waiting for Human Review；
- PM 可以创建和分配 Task；
- Coder 可以在隔离 Worktree 修改代码；
- QA 可以检查代码并运行测试；
- Dashboard 实时显示 Chat、Tasks 和 Events；
- Dashboard 使用单 Workstream WebSocket、Cursor Pagination 和 Virtualized List；
- 每次 LLM Run 都记录 Wake Reason、Context Pack Size 和 Token Ledger；
- Runtime 可以抑制无关或重复 Agent Wake-up；
- Agent-to-Agent Message 使用结构化类型，纯 ACK 不调用 LLM；
- Workstream 支持可配置的总 Token Budget、Soft Limit 和 Hard Limit；
- Token Hard Limit 可以停止新 Run 并进入 Waiting for Human；
- Agent 有效协作次数不使用统一硬上限；
- 无新 Evidence 且不推进状态的 Agent Loop 可以被熔断；
- 10,000 Event / 1,000 Message Load Test 无消息丢失和重复展示；
- 基础设施 P95 Latency 满足 Day 1 Performance Budget；
- Workstream 可以 Pause；
- 所有 Agent 在 Pause 时创建 Checkpoint；
- Workstream 可以随时生成基于结构化状态的 Summary Report So Far；
- Pause 和 Complete 前自动生成 Workstream Summary；
- Docker 全部重启后可以 Resume；
- Human 可以将 Workstream 标记为 Completed；
- 完成后所有历史仍然可查看；
- 至少通过一个真实 Repository 的完整 E2E 测试。

## 30. 下一步

1. 建立 AgentWeave Monorepo；
2. 将本规格拆分为 Architecture、Protocol、Event Catalog、Skill Protocol、Retro Protocol 和 ADR；
3. 实施 Phase 0；
4. 在 Mock Provider 上验证 Workstream 状态机；
5. 接入 Codex App Server；
6. 使用 AgentWeave 自身开发并验证后续功能。
