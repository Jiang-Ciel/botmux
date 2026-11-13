> 历史工单式 Router 设计。常驻池与长期对话 Project 的当前行为见 [router-session-pool.md](router-session-pool.md)，后者取代本文的范围锁定、逐任务验收与独立执行 session 策略。

# 默认隐藏 Agent Router

## 职责与入口

普通真人消息进入隐藏 Router。Router 不执行任务，只整理用户 prompt、澄清真实歧义、关联 task，输出规范化需求、约束和待验收步骤。给用户看的是子弹行摘要；给执行者的输入同时包含规范化 instruction 和完整原始材料/相关对话 JSON，不能用摘要替代代码、路径、字符串或注释。原文不再按 32K 或最近 24 条截断。

明确且已授权的普通任务默认告知后直接派发，例如文本格式化、查询、用户要求的代码修复。`requiresApproval: true` 仅用于确有授权边界的问题，例如破坏性、发布、付费或超出原任务范围的操作；可以逐 proposal 设置。明确批准、取消、验收仍由宿主控制车道处理，模型不能伪造这些控制操作。已有审批提案保持可批准；普通任务无须固定审批仪式。

同一窗口可有多个独立 task；只有独立需求才 `newTask:true`。补充原材料、回答执行者的问题、修改交付反馈应以 `continue` 关联原 task，不创建新 task/session。多任务归属不明确时先问用户。后台明确询问输入不属于交付，用户随后贴材料属于上下文延续。

## 执行与连续性

- 初次受理：建立 task，写入 `dispatching`，创建独立受管执行 session，再经原内容策略与 worker admission 派发。
- 补充：使用同 task 的精确 session ID 和新的 attempt/turn，保留原规范化需求，携带完整相关上下文，构造当前 CLI 的 follow-up input；不 fork、不创建新 session。
- 注入前核查 bot、owner、task、worker generation、native session、实际忙闲和受管等待。受管 Ask/TUI/attention 仍走原交互；运行忙时保留输入并提示稍后继续，不另起任务、不擅自 steer。
- 新独立任务有独立原文和 session，不继承另一个任务的代码材料。
- 多个明确任务返回全部派发项；混合批次仍显示待批准/等待项目的项。
- 对确定未发送的续接拒绝恢复原 attempt；发送结果不明保留 `dispatching` 栅栏，禁止盲目重放。

## 状态与交付

状态仍是 collecting → proposed（需要审批或等待资源）→ dispatching → running → review → completed；未派发可 cancelled，执行缺失/中断为 blocked。

`running + waitingInput` 表示任务等待用户材料，不是 `review`。执行 prompt 要求用 `[BOTMUX_TASK_WAITING]` 标识补充输入、`[BOTMUX_TASK_RESULT]` 标识成果。兼容旧执行者未加标记的明显索要代码/批准回复；代码块内的字面标记或注释不参与判定，多个标记按最后一个结果判定。文本标记是兼容性提示，不是严格验证逻辑和验收条件的证明；最终验收由用户决定。

进入 review 要求精确 attempt turn delivered、实际不 busy、不等待交互或补充输入。一轮 assistant 回答/worker 空闲不自动等于成果：索要脚本的回复保持等待输入。验收仍核对精确 turn 与实际状态，不能验收旧 attempt。

## 持久化与安全边界

`<dataDir>/agent-router/ledger.json` 保存 task、原文/相关对话、来源消息、版本、去重 ID、attempt/session。flock + 原子 fsync；损坏账本 fail closed。模型分析写回采用 revision CAS，执行变化不能被旧分析覆盖。原文不静默截断；超出 provider 上下文能力时分析失败并保留材料，不派发不完整请求。

项目只从 realpath 归一的授权列表选择。同 checkout 的 dispatching/running/blocked 任务与实际 busy/waiting 会话阻止新的写入；isolated 只表示独立临时目录，不意味着只读工具。执行恢复和未知派发仍使用既有受控通道，本次未增加周期自动重试或解锁机制。

## 兼容与影响面

- 默认 Router Pi RPC；执行由当前 Bot 的 CLI adapter 完成，续接使用共用 follow-up builder，覆盖 Pi、Codex clean-input、Claude。
- `agentRouter:false`、斜杠命令、机器人消息、监听器、工作流节点、adopt、会议及内部续跑不改变。
- 结构化 Ask、TUI、attention、选仓保持原受管通道；附件进入文本 Router 时仍明确拒绝，不静默丢弃。
- 账本按 bot/requester/窗口关联，跨窗口目标仍要求同 owner 与授权项目。内容策略、owner env、worker admission 保留。
- 本次改动主要是平台无关的 TypeScript ledger 与飞书入口；不更改 PTY/Tmux 后端、其它 IM 的路由或 CLI 协议本身。

## 验证

定向测试覆盖长代码原文、澄清后完整上下文、默认执行/必要审批、原 session 续接与重启账本、等待输入不误验收、旧 turn 不可验收、忙/关闭/中断拒绝、独立任务材料隔离、多任务/混合批准批次、确定未发送回滚、未知派发禁止重放、跨实例 CAS 和项目互斥。入口 harness 用真实 daemon 函数与外部假边界，验证 Pi/Codex/Claude 续接不创建 session、不 fork。

构建、类型检查和测试结果以本次实际命令为准。飞书真实消息收发、真实模型遵守标记和服务重启恢复需单独 live 验收，不能用单测替代。

### 本次异常交叠复验

- 分析中取消：promise barrier 保持 provider 未完成，取消先使 collecting task cancelled，旧分析 CAS 失败，无 dispatch。
- review 的 A 续接与同 checkout 的 B running 交叠：拒绝续接；撤出项目授权也拒绝。排除 own session 后，原任务等待输入仍可续接。
- B 输入分析期间 reconcile 写 A 输出：按源 messageId 迁出 B，保留 A 的并发输出，A 不携带 B 的原文。
- bind 等待期间中断/受管等待/owner 变化：不向 worker 发送；确定 send false 恢复原 attempt，同 session 可再次补充；未知发送保持 fence。
- 真实 TerminalRenderer 同屏保留旧 WAITING、新 RESULT：按最新标记判断，可验收新成果。
- 混合批次：自动执行项与待批准项同时可见，不静默遗漏。
- 变异复验：临时去掉项目权限/栅栏、消息迁出过滤、最新标记判断，新测试 8 项咬红；恢复实现后 99 项定向测试通过。

验证命令：`bun run test -- test/router-continuity.test.ts test/default-router.test.ts test/router-multitask.test.ts test/default-router-ingress.test.ts test/default-router-pi.test.ts test/command-router-dash.test.ts test/test-hygiene.test.ts`（99 passed）；`bun run build`（含 typecheck 与 dist/assets audit，通过）。隔离探针均通过 `bun scripts/fenced-run.ts -- bun /tmp/<probe>.ts`，不触及真实会话状态。未声称全量测试或飞书真人端到端通过。
