import { createHash, randomUUID, randomInt } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWriteFileSync } from '../utils/atomic-write.js';
import { withExclusiveFileLock } from '../utils/file-flock.js';
import { routerTaskSummaryCard } from '../im/lark/router-task-card.js';
import { routerDecision, routerNeedsInput, routerTaskInput, type RouterTask, type RouterInput, type RouterResult, type RouterDispatch, type RouterProvider } from './default-router.js';

export interface PoolSlot {
  id: string; owner: string; sessionId?: string; workingDir?: string;
  taskId?: string; recentTaskIds: string[]; creating?: boolean;
}
export interface ConversationProject {
  id: string; owner: string; title: string; taskId: string; sessionId?: string; revision: number; closed?: boolean;
}
interface State { version: 1; slots: PoolSlot[]; tasks: RouterTask[]; projects: ConversationProject[] }
export interface PoolInput extends RouterInput { routingOrigin?: RouterTask['routingOrigin']; poolSize?: number; projectAction?: 'create' | 'merge' | 'direct'; mergeProjectId?: string; projectName?: string }
const digest = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 16);
const active = (t: RouterTask) => ['dispatching', 'running', 'blocked'].includes(t.state);

/** A pool is scoped to one authenticated bot/requester. Opaque native context
 * is never the routing authority; recent tasks and projects live in the ledger. */
export class RouterSessionPool {
  constructor(private root: string, private provider: RouterProvider) { mkdirSync(root, { recursive: true, mode: 0o700 }); }
  private queues = new Map<string, Promise<unknown>>();
  private async tx<T>(fn: (s: State) => T): Promise<T> {
    const locked = await withExclusiveFileLock(join(this.root, 'pool.lock'), 5000, () => {
      let s: State;
      try { s = JSON.parse(readFileSync(join(this.root, 'pool.json'), 'utf8')); }
      catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; s = { version: 1, slots: [], tasks: [], projects: [] };
        try { const legacy = JSON.parse(readFileSync(join(this.root, 'ledger.json'), 'utf8')); if (legacy.version !== 1 || !Array.isArray(legacy.tasks)) throw new Error('router_legacy_invalid'); s.tasks = legacy.tasks; }
        catch (legacyError) { if ((legacyError as NodeJS.ErrnoException).code !== 'ENOENT') throw legacyError; } }
      if (s.version !== 1 || !Array.isArray(s.tasks) || !Array.isArray(s.slots) || !Array.isArray(s.projects)) throw new Error('router_pool_invalid');
      const result = fn(s);
      atomicWriteFileSync(join(this.root, 'pool.json'), JSON.stringify(s), { durable: true, mode: 0o600, followTargetSymlink: false });
      return result;
    });
    if (!locked.acquired) throw new Error('router_pool_locked');
    return locked.value;
  }
  private facts(input: RouterInput) { return input.executions ?? (input.execution ? [input.execution] : []); }
  private reconcileState(s: State, facts: NonNullable<RouterInput['execution']>[], ownerPrefix?: string) {
    for (const t of s.tasks.filter(t => (!ownerPrefix || t.owner.startsWith(ownerPrefix)) && ['running', 'dispatching'].includes(t.state))) {
      const f = facts.find(f => f.sessionId === t.attempt?.sessionId);
      // Dormant restored sessions are not completion; leave the task bound.
      if (t.state === 'dispatching' && !(f?.delivered && f.turnId === t.attempt?.turnId && !f.busy && !f.waiting)) continue;
      if (!f || f.closed || f.interrupted) { t.state = 'blocked'; t.revision++; continue; }
      t.executionDirectory ??= f.workingDir ?? t.project;
      const waiting = f.waiting || routerNeedsInput(f.response);
      if (waiting !== t.waitingInput) { t.waitingInput = waiting; t.revision++; }
      if (f.response && f.turnId === t.attempt?.turnId && t.lastResponse !== f.response) {
        t.lastResponse = f.response;
        t.history.push({ role: 'assistant', text: f.response, messageId: `response:${f.turnId}` });
      }
      const result = f.response?.replace(/```[\s\S]*?```/g, '').lastIndexOf('[BOTMUX_TASK_RESULT]') ?? -1;
      // RESULT is an executor outcome, not hidden reasoning. Transport delivery
      // remains authoritative, but different adapters may settle its turn later.
      if (!f.busy && !waiting && f.turnId === t.attempt?.turnId && f.delivered) {
        t.state = t.conversationProjectId ? 'review' : t.queued && t.directSessionId ? 'proposed' : 'completed'; t.revision++;
        const slot = s.slots.find(slot => slot.taskId === t.id);
        if (slot && !t.conversationProjectId) { slot.taskId = undefined; slot.recentTaskIds = [...slot.recentTaskIds.filter(id => id !== t.id), t.id].slice(-12); }
      } else if (result >= 0 && !f.busy && !waiting && f.turnId === t.attempt?.turnId && !f.delivered) {
        // Keep truthful status while settlement catches up; model can see the
        // output and must not claim 'no result'. Do not reuse this slot yet.
        t.waitingInput = false;
      }
    }
  }
  async reconcile(facts: NonNullable<RouterInput['execution']>[], ownerPrefix?: string) { await this.tx(s => this.reconcileState(s, facts, ownerPrefix)); }
  async listTasks(owner?: string, conversation?: string) {
    return this.tx(s => structuredClone(s.tasks.filter(t => (!owner || t.owner === owner) && (!conversation || t.conversations?.includes(conversation) || t.conversation === conversation))));
  }
  async listSlots(owner: string) { return this.tx(s => structuredClone(s.slots.filter(slot => slot.owner === owner))); }
  async listProjects(owner: string) { return this.tx(s => structuredClone(s.projects.filter(p => p.owner === owner && !p.closed))); }
  /** Reserves exactly N durable slots. The daemon may prewarm empty sessions;
   * startup claims are not replayed after an uncertain create/bind failure. */
  async releaseSlotCreation(id: string, owner: string) {
    await this.tx(s => { const slot = s.slots.find(slot => slot.id === id && slot.owner === owner); if (slot && !slot.sessionId) slot.creating = false; });
  }
  async retireClosedSlots(owner: string, facts: NonNullable<RouterInput['execution']>[]) {
    await this.tx(s => {
      for (const slot of s.slots.filter(slot => slot.owner === owner && slot.sessionId)) {
        if (!facts.find(f => f.sessionId === slot.sessionId)?.closed) continue;
        if (slot.taskId) { const task = s.tasks.find(t => t.id === slot.taskId); if (task && active(task)) { task.state = 'blocked'; task.queued = false; task.revision++; } }
        slot.sessionId = undefined; slot.taskId = undefined; slot.workingDir = undefined; slot.creating = false;
      }
    });
  }
  async reserveSlots(owner: string, size = 4): Promise<PoolSlot[]> {
    return this.tx(s => {
      const slots = s.slots.filter(slot => slot.owner === owner);
      for (let i = slots.length; i < Math.max(1, Math.min(16, size)); i++) {
        const slot = { id: randomUUID(), owner, recentTaskIds: [] }; s.slots.push(slot); slots.push(slot);
      }
      const empty = slots.filter(slot => !slot.sessionId && !slot.creating && !slot.taskId);
      for (const slot of empty) slot.creating = true;
      return structuredClone(empty);
    });
  }
  async bindSlot(id: string, owner: string, sessionId: string, workingDir: string) {
    await this.tx(s => {
      const slot = s.slots.find(slot => slot.id === id && slot.owner === owner);
      if (!slot || slot.sessionId) throw new Error('router_pool_slot_stale');
      slot.sessionId = sessionId; slot.workingDir = workingDir; slot.creating = false;
    });
  }
  slotDirectory(owner: string, slotId: string) {
    const dir = join(this.root, 'workspaces', digest(owner), slotId); mkdirSync(dir, { recursive: true, mode: 0o700 }); return dir;
  }
  private ready(f: NonNullable<RouterInput['execution']> | undefined) { return !!f && !f.busy && !f.waiting && !f.closed && !f.interrupted; }
  private claim(s: State, t: RouterTask, input: PoolInput, preferredSession?: string): RouterResult {
    if (!input.projects.includes(t.project)) return { kind: 'reply', text: '该任务的工作目录不在当前授权列表，未派发。' };
    if (t.approvalRequired) return { kind: 'reply', text: '该操作需要确认授权，请使用任务卡片。' };
    if (['completed', 'cancelled'].includes(t.state) && !t.conversationProjectId) return { kind: 'reply', text: '该单次任务已结束，不会重派。' };
    const facts = this.facts(input);
    if (t.directSessionId) {
      const original = facts.find(f => f.sessionId === t.directSessionId);
      if (!original || original.closed || original.interrupted || t.state === 'blocked') {
        t.state = 'blocked'; t.queued = false; t.revision++;
        return { kind: 'reply', text: '原 session 已关闭、中断或绑定失效，无法自动续接；补充内容已保留，需要核查恢复。' };
      }
      if (['running', 'dispatching'].includes(t.state)) { t.queued = true; return { kind: 'reply', text: '补充已保留，等待原轮准确结算后继续，不重放原轮。' }; }
    }
    const project = t.conversationProjectId ? s.projects.find(p => p.id === t.conversationProjectId && p.owner === t.owner && !p.closed) : undefined;
    if (t.conversationProjectId && (!project || project.closed || t.state === 'completed' || t.state === 'cancelled')) {
      t.queued = false; return { kind: 'reply', text: '对话 Project 已结束或绑定失效，不会重新起任务或换 session。' };
    }
    let slot: PoolSlot | undefined;
    let sessionId = project?.sessionId ?? t.directSessionId ?? preferredSession;
    if (!project) {
      const available = s.slots.filter(slot => slot.owner === t.owner && !slot.taskId && slot.sessionId && !slot.creating && this.ready(facts.find(f => f.sessionId === slot.sessionId)));
      slot = sessionId ? available.find(slot => slot.sessionId === sessionId) : undefined;
      if (!slot && !t.directSessionId) slot = available.length ? available[randomInt(available.length)] : undefined;
      if (!slot) { t.queued = true; t.state = 'proposed'; return { kind: 'reply', text: '任务已排队。', card: routerTaskSummaryCard(t.title, t.coreWork ?? t.title, '等待空闲 session，空闲后自动执行。') }; }
      sessionId = slot.sessionId;
    } else {
      const f = facts.find(f => f.sessionId === sessionId);
      const prior = s.tasks.find(other => other.id === project.taskId);
      if (!sessionId || !f || f.closed || f.interrupted || prior?.state === 'dispatching' || f.busy || f.waiting && !routerNeedsInput(f.response)) {
        t.queued = true; return { kind: 'reply', text: '- 已补充到原对话 Project，原 session 忙或等待受管交互，空闲后继续。' };
      }
    }
    const fenced = s.tasks.some(other => other.id !== t.id && !other.isolated && other.project === t.project && active(other));
    if (!t.isolated && (fenced || input.projectBusy?.(t.project, sessionId))) { t.queued = true; if (!t.conversationProjectId) t.state = 'proposed'; return { kind: 'reply', text: '- 已保留任务，等待工作目录空闲，不并发写入同一 checkout。' }; }
    if (slot) slot.taskId = t.id;
    const attemptId = randomUUID();
    t.attempts ??= []; if (t.attempt) t.attempts.push(t.attempt);
    t.attempt = { id: attemptId, sessionId, turnId: input.messageId }; t.state = 'dispatching'; t.queued = false; t.revision++;
    t.poolSlotId = slot?.id;
    t.executionDirectory = project ? t.executionDirectory : slot?.workingDir;
    if (!t.executionDirectory) throw new Error('router_pool_directory_missing');
    return { kind: 'dispatch', taskId: t.id, attemptId, sessionId, project: t.executionDirectory, title: t.title,
      sourceMessageId: input.messageId, instruction: `${project ? '这是长期研讨的下一轮，允许按本轮用户需求拓展和修改，不要以旧范围拒绝。' : '这是独立的一次性任务；不要把 session 中不相关的旧任务作为本次要求。'}\n${t.isolated ? '仅处理提供的文本或公共信息，不访问代码仓库。' : `授权代码仓库：${t.project}；工具操作使用该绝对目录，不要修改池的启动目录。`}\n${routerTaskInput(t)}`,
      summary: `- ${project ? '对话 Project' : '单次任务'}：${project?.title ?? t.title}\n- 需求：${t.instruction}\n- ${project ? '沿用唯一 session/task 持续迭代。' : '完成后关闭本次 task，保留池 session。'}` };
  }
  async handle(input: PoolInput): Promise<RouterResult> {
    const key = `${input.owner}:${input.conversation}`;
    if (/^(取消任务|cancel task)(?:\s+[a-f0-9-]+(?:\s+v\d+)?)?$/i.test((input.controlText ?? input.text).trim())) return this.handleSerial(input);
    const previous = this.queues.get(key) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(() => this.handleSerial(input)); this.queues.set(key, next);
    try { return await next; } finally { if (this.queues.get(key) === next) this.queues.delete(key); }
  }
  private async handleSerial(input: PoolInput): Promise<RouterResult> {
    const snapshot = await this.tx(s => {
      this.reconcileState(s, this.facts(input), input.owner);
      const linked = s.tasks.filter(t => t.owner === input.owner && (t.conversation === input.conversation || t.conversations?.includes(input.conversation)));
      if (s.tasks.some(t => t.owner === input.owner && t.seen.includes(input.messageId))) return { result: { kind: 'reply' as const, text: '这条消息已受理。' } };
      const control = (input.controlText ?? input.text).trim();
      const match = control.match(/^(批准执行|approve task|取消任务|cancel task|验收完成|accept task)(?:\s+([a-f0-9-]+)(?:\s+v(\d+))?)?$/i);
      const target = input.targetTaskId ?? match?.[2];
      let t = target ? linked.find(t => t.id === target) : undefined;
      if (target && !t) return { result: { kind: 'reply' as const, text: '任务不属于当前对话或请求者。' } };
      if (input.expectedRevision !== undefined && (!t || t.revision !== input.expectedRevision)) return { result: { kind: 'reply' as const, text: '任务卡片已变化，请刷新。' } };
      if (input.projectAction && t) {
        if (input.projectAction === 'direct') {
          if (!t.projectOffer || t.conversationProjectId || t.state === 'cancelled') return { result: { kind: 'reply' as const, text: '归属选择已失效，请刷新卡片。' } };
          t.projectOffer = undefined; t.seen.push(input.messageId); t.revision++; t.proposalRevision = t.revision;
          t.directSessionId = t.attempt?.sessionId;
          const original = this.facts(input).find(f => f.sessionId === t!.directSessionId);
          if (t.directSessionId && (!original || original.closed || original.interrupted || t.state === 'blocked')) {
            t.state = 'blocked'; t.queued = false;
            return { result: { kind: 'reply' as const, text: '原 session 已关闭、中断或绑定失效，无法自动续接；补充已保留，请核查恢复。' } };
          }
          if (['running', 'dispatching'].includes(t.state)) {
            t.queued = true;
            return { result: { kind: 'reply' as const, text: '已放弃创建 Project；原任务本轮结束后继续执行补充内容，不新建长期项目。' } };
          }
          t.state = 'proposed';
          return { result: this.claim(s, t, input, t.directSessionId) };
        }

        if (input.projectAction === 'create') {
          if (t.conversationProjectId) return { result: { kind: 'reply' as const, text: '该任务已经关联长期 Project。' } };
          const hasPendingIteration = !!t.projectOffer;
          const title = (input.projectName ?? t.projectOffer?.title ?? t.title).trim();
          if (!title || title.length > 160) return { result: { kind: 'reply' as const, text: '请填写有效的对话 Project 名称。' } };
          const id = randomUUID();
          t.executionDirectory ??= this.facts(input).find(f => f.sessionId === t!.attempt?.sessionId)?.workingDir ?? t.project;
          const slot = s.slots.find(slot => slot.sessionId === t!.attempt?.sessionId);
          if (slot?.taskId && slot.taskId !== t.id) return { result: { kind: 'reply' as const, text: '原池 session 已执行另一任务；请等待空闲后再创建长期 Project，不抢占执行。' } };
          if (slot) { slot.sessionId = undefined; slot.taskId = undefined; slot.creating = false; slot.recentTaskIds = []; }
          const project = { id, title, taskId: t.id, sessionId: t.attempt?.sessionId, owner: t.owner, revision: 1 };
          s.projects.push(project); t.conversationProjectId = id; t.projectOffer = undefined; t.revision++;
          if (t.state === 'completed') t.state = 'review';
          t.seen.push(input.messageId);
          if (['dispatching', 'running'].includes(t.state)) { t.queued = hasPendingIteration; return { result: { kind: 'reply' as const, text: `- 已创建长期 Project：${title}\n- 原 session/task 保持不变，本轮结束后继续迭代。` } }; }
          return { result: this.claimProjectOrReserve(s, t, input) };
        }
        const p = s.projects.find(p => p.id === input.mergeProjectId && p.owner === input.owner && !p.closed);
        if (!p || !t.projectOffer?.candidates.includes(p.id)) return { result: { kind: 'reply' as const, text: '归并目标已变化或不属于当前请求者。' } };
        if (active(t)) return { result: { kind: 'reply' as const, text: '原任务仍在执行，暂不迁移或归并；请等待本轮完成。' } };
        const dest = s.tasks.find(task => task.id === p.taskId)!;
        if (!input.projects.includes(dest.project)) return { result: { kind: 'reply' as const, text: '归并目标的工作目录已不在授权范围。' } };
        for (const h of t.history.filter(h => h.role === 'user')) dest.history.push(h);
        dest.instruction = t.instruction || dest.instruction; dest.approvalRequired = t.approvalRequired === true;
        dest.proposalRevision = dest.revision + 1; dest.routingOrigin = t.routingOrigin ?? dest.routingOrigin; dest.conversations = [...new Set([...(dest.conversations ?? [dest.conversation]), input.conversation])];
        dest.sources ??= []; dest.sources.push(...(t.sources ?? [])); dest.revision++; dest.seen.push(input.messageId);
        t.state = 'cancelled'; t.projectOffer = undefined; t.seen.push(input.messageId); t.revision++;
        return { result: this.claim(s, dest, input, p.sessionId) };
      }
      if (match) {
        t ??= linked.filter(t => /批准|approve/i.test(match[1]) ? t.state === 'proposed' && t.approvalRequired : /验收|accept/i.test(match[1]) ? t.state === 'review' : !['completed', 'cancelled'].includes(t.state)).at(-1);
        if (!t) return { result: { kind: 'reply' as const, text: '没有匹配的任务。' } };
        if (match[3] && Number(match[3]) !== (t.proposalRevision ?? t.revision)) return { result: { kind: 'reply' as const, text: '方案版本已变化。' } };
        if (/批准|approve/i.test(match[1]) && t.approvalRequired && !['dispatching', 'blocked'].includes(t.state)) { t.approvalRequired = false; t.seen.push(input.messageId); return { result: this.claim(s, t, input) }; }
        if (/取消|cancel/i.test(match[1]) && !active(t)) { t.state = 'cancelled'; t.queued = false; t.seen.push(input.messageId); t.revision++; return { result: { kind: 'reply' as const, text: '已取消未执行任务。' } }; }
        if (/验收|accept/i.test(match[1]) && t.state === 'review') { t.state = 'completed'; t.queued = false; t.projectOffer = undefined; t.seen.push(input.messageId); t.revision++; const p = s.projects.find(p => p.taskId === t!.id); if (p) p.closed = true; return { result: { kind: 'reply' as const, text: '对话 Project 已结束。' } }; }
        return { result: { kind: 'reply' as const, text: '当前状态不能执行该操作；不会停止或重放运行中的任务。' } };
      }
      const scratch: RouterTask = { id: randomUUID(), owner: input.owner, conversation: input.conversation, conversations: [input.conversation], revision: 1, state: 'collecting', title: '', project: '', instruction: '', history: [{ role: 'user', text: input.text, messageId: input.messageId }], seen: [], sources: [{ conversation: input.conversation, messageId: input.messageId, relation: 'input' }], routingOrigin: input.routingOrigin };
      s.tasks.push(scratch);
      const recent = s.tasks.filter(t => t.owner === input.owner && t.id !== scratch.id).reverse().filter(t => t.state !== 'cancelled').slice(0, 12);
      const projects = s.projects.filter(p => p.owner === input.owner && !p.closed);
      return { task: structuredClone(scratch), recent: structuredClone(recent), projects: structuredClone(projects), explicitTask: t?.id };
    });
    if (snapshot.result) return snapshot.result;
    const scratch = snapshot.task!;
    let decision;
    try {
      decision = routerDecision.parse(await this.provider.decide({ conversationId: input.conversation, message: input.text, projects: input.projects,
        task: scratch, shared: snapshot.recent!, conversationProjects: snapshot.projects, explicitTaskId: snapshot.explicitTask,
        poolMode: true }, AbortSignal.timeout(120000)));
    } catch { return { kind: 'reply', text: '暂时无法分析，原始材料已保留，没有派发。请稍后重试。' }; }
    return this.tx(s => {
      const draft = s.tasks.find(t => t.id === scratch.id)!;
      if (draft.revision !== scratch.revision) return { kind: 'reply', text: '需求已变化，本轮未派发。' };
      draft.seen.push(input.messageId); draft.revision++;
      if (decision.action === 'reply' || decision.action === 'clarify') { draft.history.push({ role: 'assistant', text: decision.message }); return { kind: 'reply', text: decision.message }; }
      const targetId = snapshot.explicitTask ?? decision.targetTaskId;
      const old = targetId ? s.tasks.find(t => t.id === targetId && t.owner === input.owner && (!t.project || input.projects.includes(t.project))) : undefined;
      if (old?.conversationProjectId && !s.projects.some(p => p.id === old.conversationProjectId && p.owner === input.owner && !p.closed)) {
        draft.state = 'cancelled'; return { kind: 'reply', text: '原对话 Project 已结束，本轮分析不再派发。' };
      }
      if (targetId && !old) return { kind: 'reply', text: '相关任务不存在或不在授权范围；请重新指定。' };
      // Existing long projects accept changing educational/iterative requests.
      if (old?.conversationProjectId && (decision.action === 'continue' || !!snapshot.explicitTask)) {
        old.history.push({ role: 'user', text: input.text, messageId: input.messageId }); old.instruction = decision.instruction || input.text; old.coreWork = decision.message.trim().slice(0, 800) || old.title;
        old.revision++; old.proposalRevision = old.revision; old.conversations = [...new Set([...(old.conversations ?? [old.conversation]), input.conversation])];
        old.seen.push(input.messageId); old.routingOrigin = input.routingOrigin ?? old.routingOrigin; draft.state = 'cancelled';
        if (decision.requiresApproval) { old.approvalRequired = true; old.queued = true; if (!active(old)) old.state = 'proposed'; return { kind: 'reply', text: `${decision.message}\n- 本轮操作需要授权确认，已保留到原 Project，不执行。` }; }
        return this.claim(s, old, input, old.attempt?.sessionId);
      }
      draft.title = decision.title || old?.title || '对话任务'; draft.project = decision.project || old?.project || input.projects[0] || '';
      draft.instruction = decision.instruction || input.text; draft.coreWork = decision.message.trim().slice(0, 800) || draft.title;
      if (old?.state === 'collecting' && !old.projectOffer) { draft.history = [...old.history, ...draft.history]; old.state = 'cancelled'; old.revision++; } draft.isolated = decision.isolated ?? old?.isolated ?? true;
      if (!input.projects.includes(draft.project)) return { kind: 'reply', text: '请明确允许的工作目录；对话 Project 不要求绑定代码仓库。' };
      const long = decision.longTerm === true || (decision.action === 'continue' || !!snapshot.explicitTask) && !!old;
      const candidates = (decision.similarProjectIds ?? []).filter(id => snapshot.projects?.some(p => p.id === id));
      if (long || candidates.length) {
        draft.approvalRequired = decision.requiresApproval === true;
        draft.projectOffer = { title: decision.projectName || draft.title, candidates, relatedTaskId: old?.id };
        if (old && long) {
          // The card promotes the existing task/session, preserving identity.
          old.history.push({ role: 'user', text: input.text, messageId: input.messageId }); old.instruction = draft.instruction; old.coreWork = draft.coreWork; old.revision++;
          old.projectOffer = draft.projectOffer; old.approvalRequired = draft.approvalRequired; old.proposalRevision = old.revision; old.conversations = [...new Set([...(old.conversations ?? [old.conversation]), input.conversation])];
          old.seen.push(input.messageId); old.routingOrigin = input.routingOrigin ?? old.routingOrigin; draft.state = 'cancelled'; draft.projectOffer = undefined;
          return { kind: 'reply', text: '- 这是连续研讨，已保留到原任务。请在对话卡片创建长期 Project，或确认归并到相似 Project；无需另开任务。' };
        }
        return { kind: 'reply', text: '- 已识别长期对话，请在卡片创建 Project；如有相似 Project，可确认归并。' };
      }
      draft.approvalRequired = decision.requiresApproval === true;
      draft.state = 'proposed'; draft.proposalRevision = draft.revision;
      if (draft.approvalRequired) return { kind: 'reply', text: `${decision.message}\n- 该操作涉及授权边界，请在卡片确认。` };
      return this.claim(s, draft, input);
    });
  }
  private claimProjectOrReserve(s: State, t: RouterTask, input: PoolInput): RouterResult {
    const p = s.projects.find(p => p.id === t.conversationProjectId)!;
    if (p.sessionId) return this.claim(s, t, input, p.sessionId);
    // A newly drafted long project needs one free pool executor, which is then
    // detached from the pool; subsequent reserveSlots replaces the empty slot.
    const original = t.conversationProjectId; t.conversationProjectId = undefined;
    const result = this.claim(s, t, input); t.conversationProjectId = original;
    if (result.kind === 'dispatch') {
      p.sessionId = result.sessionId;
      const slot = s.slots.find(slot => slot.id === t.poolSlotId);
      if (slot) { slot.sessionId = undefined; slot.taskId = undefined; slot.creating = false; slot.recentTaskIds = []; }
      t.poolSlotId = undefined;
    }
    return result;
  }
  async drain(input: PoolInput): Promise<RouterDispatch[]> {
    return this.tx(s => {
      this.reconcileState(s, this.facts(input), input.owner);
      const results: RouterDispatch[] = [];
      for (const t of s.tasks.filter(t => t.owner === input.owner && t.queued && !['completed', 'cancelled'].includes(t.state) && !t.approvalRequired && !t.projectOffer)) {
        const result = t.conversationProjectId ? this.claimProjectOrReserve(s, t, { ...input, messageId: t.history.filter(h => h.role === 'user').at(-1)?.messageId ?? input.messageId })
          : this.claim(s, t, { ...input, messageId: t.history.filter(h => h.role === 'user').at(-1)?.messageId ?? input.messageId });
        if (result.kind === 'dispatch') results.push(result);
      }
      return results;
    });
  }
  async bind(attemptId: string, sessionId: string) {
    await this.tx(s => { const t = s.tasks.find(t => t.attempt?.id === attemptId); if (!t || t.state !== 'dispatching' || t.attempt?.sessionId !== sessionId) throw new Error('router_pool_dispatch_stale'); });
  }
  async finish(attemptId: string, sessionId: string | undefined, accepted: boolean) {
    await this.tx(s => { const t = s.tasks.find(t => t.attempt?.id === attemptId); if (t?.state === 'dispatching' && accepted && t.attempt?.sessionId === sessionId) { t.state = 'running'; t.revision++; } });
  }
  async rejectContinuation(attemptId: string) {
    await this.tx(s => {
      const t = s.tasks.find(t => t.attempt?.id === attemptId); if (!t || t.state !== 'dispatching') return;
      const slot = s.slots.find(slot => slot.taskId === t.id); if (slot) slot.taskId = undefined;
      t.attempt = t.attempts?.pop(); t.state = t.conversationProjectId ? 'review' : 'proposed'; t.queued = true; t.revision++;
    });
  }
}
