# 默认隐藏 Agent Router（首版）

## 入口与体验

普通的真人消息默认进入 Router，无 `/router` 斜杠命令。Router 是内部进程，不登记到执行会话列表、不创建窗口、不流式展示推理。澄清问题、任务提案及故障提示通过原消息作用域回传。

用户明确项目、需求、验收条件后，Router 给出提案；回复「批准执行」才进入既有执行 session 或在当前话题创建执行 session。回复「取消任务」只取消尚未派发的任务；执行交付后回复「验收完成」关闭任务并释放 ledger 栅栏。一个话题/请求者一个 Task，完成后新任务另开话题。普通群 chat-scope 仍共享入口；首版不会自动拆分消息为多个窗口。

飞书自动 @ 的正文与控制车道分离。控制词由已剥离 mention 的宿主字段匹配；模型不能批准、取消或验收任务。

## 范围与兼容

- 现有斜杠命令、回调 URL、结构化 Ask 答复、已有选仓、TUI、attention 答复保持既有通道。
- 机器人消息、监听器、工作流节点、受管 principal lane、adopt 会话、会议入口及内部续跑不进入首版语义路由。
- 文本首版；附件在进入 Router 时明确提示不支持，不会静默丢失后执行。
- Router provider 默认 Pi RPC，执行仍使用当前 Bot 的 CLI adapter；也兼容 Codex clean-input 正文。
- `agentRouter: false` 恢复直接执行；`agentRouter: { executable, model }` 指定 Router Pi 可执行文件/模型。缺省启用，Pi Bot 继承 Pi executable/model；其他 CLI Bot 使用 `pi` 与其本机默认模型。可执行文件为一个命令，不是 shell 模板。
- RouterProvider 为模型无关的结构化接口；首版仅提供 Pi 实现，不声称已有第二种 router adapter。
- 项目来自显式已校验目录、当前 session、oncall/inherit/default pin 和配置目录，并按 realpath 归一。每次批准重新核查当前允许列表。

## 持久状态

`<dataDir>/agent-router/ledger.json` 存储任务、需求版本、限定长度的历史、消息去重 ID、执行 attempt 和 session ID。flock 临界区 + 原子 fsync 写入；损坏账本 fail closed，不以空账本覆盖。不同 daemon 共用账本，项目级互斥在同一事务中生效。

会话键含 bot、chat、scope、anchor、requester，共享事实仅同 app/requester 且在当前项目列表内。Pi 进程无工具、MCP、扩展、技能和项目上下文，owner env 在配置覆盖后冻结。每个 provider 最多 16 个进程，空闲 5 分钟回收；账本为权威上下文，进程重启后重新提供。内部 RPC 为无文件会话，不出现在 Pi 原生 session 列表。

状态：collecting → proposed → dispatching → running → review → completed。未派发可 cancelled；执行缺失/中断为 blocked。

- 编辑需求先使旧提案失效，即使推理失败，也不能批准旧需求。
- 派发前写 `dispatching`；接受后关联 session 为 `running`。结果不明保留 fence，禁止重放。
- 观察到执行状态改变须递增 revision，拒绝旧分析写回。
- 同 checkout 有 dispatching/running/blocked/review Task 时拒绝另一 Task。既有执行会话实际 busy/waiting 也阻止派发。只保证 Router 受管任务间的单写者；既有命令/外部 CLI 不是 ledger 管控的全局锁。
- prompt ACK 和 agent_end 不等于推理结束，Pi 需 agent_settled + 正常 assistant stop + 合法 JSON。
- 验收需当前精确 attempt turn 已 delivered，且 runtime 不 busy、不 waiting。todos 不作为完成证明。

## 首版恢复边界

持久化需求、失败后用户重试 Router 分析、沿用既有执行恢复接口。没有新的周期自动恢复控制器，没有任意 CLI 自动重跑，没有复杂 DAG 或跨话题自动改路由。缺失/失败执行保留 blocked fence；不自动释放，即使用户要求取消。未知派发需要操作员核查，首版不提供额外解锁命令。

新消息不是自动续跑授权；模型的 continue 只回传说明，不派发。授权/补充信息通过原受管 Ask/attention 交互返回执行者。鉴权沿用现有登录机制，不在聊天索取密钥。

## 验证及故障复核

定向 ledger、RPC、入口 seam 测试覆盖明确批准、去重、跨账本互斥、坏文件、改需求推理失败、精确验收、跨实例分析/中断交叠、review/取消/重新忙交叠和模型 continue 不触发执行。

复核探针发现并修正：
1. 持久 `active` 被误作 busy，验收后仍阻止新任务；改运行事实投影。
2. 自动 @ 导致批准控制词不识别；正文与控制车道分离。
3. Codex clean-input 收到批准词而非需求；同步已批准正文。
4. B 落盘 blocked 后 A 旧分析覆盖成 proposed；观察变更递增版本且限定 propose 来源。
5. review 中取消释放仍可能写入的执行；仅未派发状态可取消。

上述问题均通过真实组件和隔离探针复现，新增回归覆盖修正。完整飞书真人端到端、实际模型鉴权、服务重启后的恢复仍需 live 验收，不能以定向单测代替。
