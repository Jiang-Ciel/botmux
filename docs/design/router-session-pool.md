# Router 常驻池与长期对话 Project

## 用户体验

Router 是简单意图判别与输入整理，不是冻结范围的工单审批器。Python代码修正、datetime checklist、样例讨论可以作为同一长期研讨迭代。普通问题不逐任务批准，真实破坏性/对外发布/付费/权限边界才确认。

- 单次、无连续性（btw 等）：默认4个可配置常驻执行session，每个同一时刻只能执行一个task。随机选真正空闲槽位，单次task完成自动completed，执行session保留。全忙自动排队，tick发现空闲后派发。
- 长期：展示独立对话卡片，用户创建命名Project；Project不是仓库路径，绑定唯一task/session。后续迭代直接使用同一绑定，不以旧需求范围拒绝。相似Project仅作为候选，通过卡片确认归并，不隐式归并。
- 首次连续问题可将已有单次task/session提升为长期Project，保留身份。若该池session已开始另一个task，不抢占或迁移正在执行的任务。
- 把池session提升成长期Project后，池槽位补建空session维持4个；长期Project不占普通池容量。

## 输入与状态

`RouterSessionPool` 在 `agent-router/pool.json` 用flock和原子fsync保存slots/tasks/projects；模型只作判别，宿主决定owner、slot、绑定和执行。首次加载保留旧 `ledger.json` task作为最近对话材料，不清空历史。

短task走collecting/proposed/dispatching/running/completed。waitingInput不算交付；长期task每轮完成进入review但仍可继续，显式结束Project才completed。真实transcript交付 `completedIdleTurnId` 和精确currentTurnId补足lastTurn落盘稍晚的情况；不能把隐藏思考或任意输出当作交付。原始用户文本完整保存，最近相似性来自账本，不依赖模型不透明session上下文。

每个pool按bot/requester隔离。池session持久 `routerPool` 元数据用于独立runtime key，task改变不改变池runtime key。不同任务可共享池session的原生上下文，但当前input明确声明新单次task不得继承不相关的旧指令。用户只要求关闭task而保留session，因此不自动清空原生context。

## 调度与执行

空槽位预热无任务的CLI进程，不向模型发送空白工作。执行使用原CLI follow-up builder，支持Pi/Codex clean input/Claude；恢复使用原session/native session的受控resume，不建立替代session。派发先写dispatching，确定未发送恢复可排队；未知结果不重放。每次送入执行前再次核验owner、bot、worker generation、session状态与受管等待。代码仓库是授权tool目录，不等同池启动目录；代码task在instruction注明绝对授权路径，仍按同checkout写入互斥。

后台tick按持久routingOrigin恢复待派发的消息目标，并重新核验操作人权限；busy或受管Ask/TUI/attention不强行注入或steer。普通附件入口仍明确提示文本Router不支持，不静默丢弃。

## 配置与影响面

`agentRouter.poolSize` 范围1–16，缺省4；改变配置不关闭正在运行的slot。首版缩容不强行删除历史slot，需在空闲后管理；不把历史数据删除混入路由修改。

涉及BotConfig规范化、飞书卡片与daemon、Router ledger、共享runtime session key与SessionStore元数据保留。其它IM入口、斜杠命令、adopt、VC、workflow不进入pool；CLI协议与PTY/Tmux不改。共享runtime key需验证普通非pool会话行为不变。

## 验证范围

真实RouterSessionPool+假provider覆盖4槽唯一预留、随机空闲派发、短task完成session保留、全忙排队与drain、datetime后续提升保持task/session、相似Project确认与跨owner拒绝、未知派发重启不重复、旧账本迁移和池session被其他task占用时不抢占。入口harness保留跨CLI和人工介入的行为测试。飞书卡片测试验证创建与归并callback、候选限制，不靠文案快照。

部署前需独立异常交叠复核、构建/类型检查和变异咬红。真实飞书消息链路、真实模型分类和卡片交互仍需live验收，不以单测代替。

## 异常交叠复验与修复

- 归并确认不代替新操作授权：复制本轮approvalRequired，文本/卡片另行批准；长期需求每次更新proposalRevision，旧文本版本批准拒绝。
- 池复用用SessionStore专用updateRouterTask CAS更新task/attempt/source，普通metadata writer不能覆盖或复活旧task；确定send=false回滚原task及reply bindings。
- Project结束原子清除queued，pending provider验证Project仍开放，drain排除终态；不能退化成随机新pool session。
- 首个预热注册明确失败时释放所有未尝试槽，未知创建保留待核查；明确closed session可安全替换空槽，不恢复其已关闭任务。
- cold fork的boolean true仅代表开始安排，最终onAdmission('rejected')回滚绑定并排队，accepted才结算running；人工关闭后CAS不复活session。
- 精确session/turn delivered可结算finish落盘丢失的dispatching，绝不重发；错turn/busy/waiting/无证据仍不结算。
- 复用执行器按host routerOrigin冻结当前turn的scope/chat/topic，不改pool runtime identity或旧turn target。真实SQLite及reply-target组件已验证第二话题结果target指向第二话题；跨群与chat-scope回归覆盖。

定向验证：12文件198项通过（包含pool/SQLite CAS/真实回复target、旧Router兼容、SessionStore复制和回复fallback），`bun run build`包含生产emit、额外typecheck、dist/assets audit通过。新增授权版本及来源target变异去掉后4项咬红；池占用/关闭/抢占保护去掉后3项咬红。全部临时探针通过`bun scripts/fenced-run.ts -- bun /tmp/<probe>.ts`，没有向真实飞书发送测试任务。实际飞书端到端仍单独验收。
