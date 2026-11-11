import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { z } from 'zod';
import { atomicWriteFileSync } from '../utils/atomic-write.js';
import { withExclusiveFileLock } from '../utils/file-flock.js';
import { saveRouterProgress, type RouterProgress, type RouterProgressSink, type RouterStage } from './router-progress.js';
import type { DaemonSession } from '../core/types.js';

export const routerDecision = z.object({
  action: z.enum(['clarify', 'propose', 'reply', 'continue']),
  message: z.string().max(12000),
  title: z.string().max(160),
  project: z.string().max(4096),
  instruction: z.string().max(32000),
  targetTaskId: z.string().optional(),
  newTask: z.boolean().optional(),
  isolated: z.boolean().optional(),
  proposals: z.array(z.object({ title: z.string().trim().min(1).max(160), project: z.string().max(4096), instruction: z.string().trim().min(1).max(32000), isolated: z.boolean().optional() }).strict()).min(1).max(8).optional(),
}).strict().refine(decision => decision.action !== 'propose' || decision.title.trim().length > 0, {
  path: ['title'], message: 'Task proposals require a title',
});
export type RouterDecision = z.infer<typeof routerDecision>;
export interface RouterProvider { decide(context: RouterContext, signal: AbortSignal, onProgress?: (stage: RouterStage) => void): Promise<RouterDecision> }
export interface RouterContext {
  conversationId: string;
  message: string;
  projects: string[];
  task: RouterTask;
  shared: Array<Pick<RouterTask, 'id' | 'project' | 'title' | 'state' | 'instruction' | 'revision'>>;
}
export interface RouterTask {
  id: string;
  conversation: string;
  conversations?: string[];
  sources?: Array<{ conversation: string; messageId: string; relation: string }>;
  isolated?: boolean;
  proposalId?: string;
  proposalRevision?: number;
  attempts?: Array<{ id: string; turnId: string; sessionId?: string }>;
  owner: string;
  revision: number;
  state: 'collecting' | 'proposed' | 'dispatching' | 'running' | 'review' | 'blocked' | 'cancelled' | 'completed';
  title: string;
  project: string;
  instruction: string;
  history: Array<{ role: 'user' | 'assistant'; text: string }>;
  seen: string[];
  attempt?: { id: string; turnId: string; sessionId?: string };
}
interface Ledger { version: 1; tasks: RouterTask[] }
export interface RouterInput {
  conversation: string; owner: string; messageId: string; text: string; controlText?: string; projects: string[];
  execution?: { sessionId: string; busy: boolean; waiting: boolean; closed: boolean; interrupted: boolean; delivered: boolean; turnId?: string };
  executions?: NonNullable<RouterInput['execution']>[];
  targetTaskId?: string;
  onProgress?: RouterProgressSink;
  projectBusy?: (project: string) => boolean;
}
export function routerExecutionFacts(ds: Pick<DaemonSession, 'session' | 'worker' | 'workerReady' | 'lastScreenStatus' | 'pendingRepo' | 'tuiPromptCardId' | 'agentAttention'>): NonNullable<RouterInput['execution']> {
  const status = ds.session.queued ? 'idle' : (!ds.worker || ds.worker.killed ? 'dormant'
    : ds.lastScreenStatus ?? (ds.workerReady === true ? 'working' : 'starting'));
  return { sessionId: ds.session.sessionId,
    busy: ['starting', 'working', 'analyzing', 'active'].includes(status),
    waiting: !!ds.tuiPromptCardId || !!ds.agentAttention || !!ds.pendingRepo,
    closed: ds.session.status === 'closed',
    interrupted: ds.session.lastTurn?.outcome === 'interrupted',
    delivered: ds.session.lastTurn?.outcome === 'delivered', turnId: ds.session.lastTurn?.turnId };
}
export type RouterResult = { kind: 'reply'; text: string } | { kind: 'dispatch'; instruction: string; project: string; attemptId: string; taskId?: string; title?: string; sourceMessageId?: string };
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
export function routerConversation(app: string, chat: string, scope: string, anchor: string, owner: string): string {
  return hash(JSON.stringify([app, chat, scope, anchor, owner]));
}
export function canonicalRouterProjects(paths: string[]): string[] {
  return [...new Set(paths.flatMap(path => { try { return [realpathSync(path)]; } catch { return []; } }))];
}

/** Durable host ledger. Models cannot approve, release a write fence, or choose
 * an arbitrary path/session. Every cross-process mutation uses flock + fsync. */
export class DefaultRouter {
  private queues = new Map<string, Promise<unknown>>();
  constructor(private root: string, private provider: RouterProvider) { mkdirSync(root, { recursive: true, mode: 0o700 }); }
  private async transaction<T>(fn: (ledger: Ledger) => T): Promise<T> {
    const result = await withExclusiveFileLock(join(this.root, 'ledger.lock'), 5000, () => {
      let ledger: Ledger;
      try { ledger = JSON.parse(readFileSync(join(this.root, 'ledger.json'), 'utf8')); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; ledger = { version: 1, tasks: [] }; }
      if (ledger.version !== 1 || !Array.isArray(ledger.tasks)) throw new Error('router_ledger_invalid');
      const value = fn(ledger);
      atomicWriteFileSync(join(this.root, 'ledger.json'), JSON.stringify(ledger), { mode: 0o600, durable: true, followTargetSymlink: false });
      return value;
    });
    if (!result.acquired) throw new Error('router_ledger_locked');
    return result.value;
  }
  async handle(input: RouterInput): Promise<RouterResult> {
    const now = Date.now();
    const progress: RouterProgress = { id: randomUUID(), routerSessionId: hash(`${input.owner}:${input.conversation}`).slice(0, 32),
      conversation: input.conversation, owner: input.owner, sourceMessageId: input.messageId,
      prompt: input.text.slice(0, 1000), stage: 'queued', startedAt: now, updatedAt: now, lastActivityAt: now, sequence: 0 };
    const emit = (stage: RouterStage, summary?: string) => {
      progress.stage = stage; progress.updatedAt = Date.now(); progress.lastActivityAt = progress.updatedAt; progress.sequence++;
      if (summary) progress.summary = summary;
      if (['completed', 'failed', 'interrupted'].includes(stage)) progress.finishedAt = progress.updatedAt;
      saveRouterProgress(this.root, progress);
      try { input.onProgress?.(structuredClone(progress)); } catch { /* progress transport is not admission */ }
    };
    emit('queued');
    const previous = this.queues.get(input.conversation) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(() => this.handleSerial(input, emit));
    this.queues.set(input.conversation, next);
    try {
      const result = await next;
      if (!progress.finishedAt) emit('completed', result.kind === 'reply' ? result.text.slice(0, 300) : '方案已确认，进入派发流程。');
      return result;
    } catch (error) { emit('failed', '分析或账本处理失败；不会自动重派执行。'); throw error; }
    finally { if (this.queues.get(input.conversation) === next) this.queues.delete(input.conversation); }
  }
  private async handleSerial(input: RouterInput, progress: (stage: RouterStage, summary?: string) => void): Promise<RouterResult> {
    progress('context');
    const text = input.text.trim();
    const control = (input.controlText ?? input.text).trim();
    const snapshot = await this.transaction(ledger => {
      const linked = ledger.tasks.filter(t => t.owner === input.owner && (t.conversation === input.conversation || t.conversations?.includes(input.conversation)));
      for (const t of ledger.tasks.filter(t => t.owner === input.owner)) {
        const facts = (input.executions ?? (input.execution ? [input.execution] : [])).find(e => e.sessionId === t.attempt?.sessionId);
        if (t.state === 'running' && input.executions && !facts) { t.state = 'blocked'; t.revision++; }
        if (t.state === 'running' && facts) {
          const state = facts.closed || facts.interrupted ? 'blocked' : facts.delivered && facts.turnId === t.attempt?.turnId && !facts.busy && !facts.waiting ? 'review' : 'running';
          if (t.state !== state) { t.state = state; t.revision++; }
        }
      }
      if (linked.some(t => t.seen.includes(input.messageId))) return { reply: '这条消息已接收，请勿重复发送。' };
      const match = control.match(/^(批准执行|approve task|取消任务|cancel task|验收完成|accept task)(?:\s+([a-f0-9-]+)(?:\s+v(\d+))?)?$/i);
      const explicit = input.targetTaskId ?? match?.[2];
      const candidates = explicit ? ledger.tasks.filter(t => t.owner === input.owner && (t.id === explicit || t.id.startsWith(explicit)) && (!t.project || input.projects.includes(t.project)))
        : match ? linked.filter(t => /^(批准执行|approve task)$/i.test(match[1]) ? t.state === 'proposed' : /^(验收完成|accept task)$/i.test(match[1]) ? t.state === 'review' : !['cancelled', 'completed'].includes(t.state)) : [];
      if ((match || explicit) && candidates.length !== 1) return { reply: candidates.length ? `请指定任务 ID 和方案版本：\n${candidates.map(t => `${t.id} v${t.proposalRevision ?? t.revision}｜${t.title}｜${t.state}`).join('\n')}` : '没有匹配的可操作任务，请先形成方案或指定正确任务 ID。' };
      let task = candidates[0] ?? (!input.executions ? linked.find(t => ['running', 'blocked', 'review', 'dispatching'].includes(t.state)) : undefined) ?? [...linked].reverse().find(t => ['collecting', 'proposed'].includes(t.state));
      if (!task) {
        task = { id: randomUUID(), conversation: input.conversation, conversations: [input.conversation], sources: [], owner: input.owner, revision: 0, state: 'collecting', title: '', project: '', instruction: '', history: [], seen: [] };
        ledger.tasks.push(task);
      }
      if (match?.[3] && Number(match[3]) !== (task.proposalRevision ?? task.revision)) return { reply: '方案版本已变化，请确认最新方案。' };
      task.conversations = [...new Set([task.conversation, ...(task.conversations ?? []), input.conversation])];
      task.sources ??= [];
      task.sources.push({ conversation: input.conversation, messageId: input.messageId, relation: match ? 'control' : 'input' });
      const execution = (input.executions ?? (input.execution ? [input.execution] : [])).find(e => e.sessionId === task.attempt?.sessionId);
      const effectiveControl = match?.[1] ?? control;
      if (task.seen.includes(input.messageId)) return { reply: '这条消息已接收，请勿重复发送。' };
      // An unknown dispatch stays fenced, even after restart or manual close.
      if (task.state === 'dispatching') return { reply: '上次派发结果尚未核实，已保留项目写入栅栏；请先核查执行会话，不会自动重发。' };
      const priorState = task.state;
      if (!input.executions && task.state === 'running' && (!execution || task.attempt?.sessionId !== execution.sessionId)) task.state = 'blocked';
      if (task.state === 'running' && task.attempt?.sessionId === execution?.sessionId) {
        if (execution?.closed || execution?.interrupted) task.state = 'blocked';
        else if (execution?.delivered && execution.turnId === task.attempt?.turnId
          && !execution.busy && !execution.waiting) task.state = 'review';
      }
      if (task.state !== priorState) task.revision++;
      if (/^(取消任务|cancel task)$/i.test(effectiveControl)) {
        if (!['collecting', 'proposed', 'cancelled', 'completed'].includes(task.state)) return { reply: '执行可能仍有副作用，请先在执行会话停止并核查；Router 不会仅凭取消消息释放写入栅栏。' };
        task.state = 'cancelled'; task.revision++; task.seen.push(input.messageId);
        return { reply: `已取消任务：${task.title || task.id}。可以在本窗口继续提出新需求。` };
      }
      if (/^(验收完成|accept task)$/i.test(effectiveControl) && task.state === 'review' && execution
        && execution.sessionId === task.attempt?.sessionId && !execution.busy && !execution.waiting
        && execution.delivered && execution.turnId === task.attempt?.turnId) {
        task.state = 'completed'; task.revision++; task.seen.push(input.messageId);
        return { reply: `任务已验收完成：${task.title}。可以在本窗口继续提出新需求。` };
      }
      if (task.state === 'cancelled' || task.state === 'completed') return { reply: '此任务已结束，新任务请另开话题。' };
      const claim = (instruction: string): RouterResult => {
        if (!task!.project || !input.projects.includes(task!.project)) return { kind: 'reply', text: '目标项目不在当前允许的项目列表中，请重新确认项目。' };
        const fenced = ledger.tasks.some(t => t.id !== task!.id && !t.isolated && t.project === task!.project
          && (['dispatching', 'running', 'blocked'].includes(t.state)
            || (t.state === 'review' && (!input.executions || input.executions.some(e => e.sessionId === t.attempt?.sessionId && (e.busy || e.waiting))))));
        if (!task!.isolated && (execution?.busy || input.projectBusy?.(task!.project) || fenced)) {
          return { kind: 'reply', text: '该项目或执行会话仍被占用，请等待完成并验收；不会并发写入同一 checkout。' };
        }
        const attemptId = randomUUID();
        task!.state = 'dispatching'; task!.revision++; task!.seen.push(input.messageId);
        task!.attempts ??= [];
        if (task!.attempt) task!.attempts.push(task!.attempt);
        task!.attempt = { id: attemptId, turnId: input.messageId, sessionId: execution?.sessionId };
        const project = task!.isolated ? join(homedir(), '.cache', 'botmux', 'router-workspaces', hash(this.root).slice(0, 16), task!.id) : task!.project;
        if (task!.isolated) mkdirSync(project, { recursive: true, mode: 0o700 });
        return { kind: 'dispatch', instruction, project, attemptId, taskId: task!.id, title: task!.title, sourceMessageId: task!.sources?.find(s => s.relation === 'input')?.messageId };
      };
      if (/^(批准执行|approve task)$/i.test(effectiveControl) && task.state === 'proposed') return { result: claim(task.instruction) };
      if (task.state === 'blocked') return { reply: '任务中断或会话已关闭，项目栅栏仍保留。请核查执行状态后使用现有受控恢复通道；不会盲目重跑。' };
      // Any edit invalidates a prior proposal before inference, including failure.
      if (task.state === 'proposed') task.state = 'collecting';
      task.history.push({ role: 'user', text: text.slice(0, 32000) }); task.history = task.history.slice(-24); task.revision++;
      return { previousState: priorState, task: structuredClone(task), shared: ledger.tasks.filter(t => t.owner === input.owner && (!t.project || input.projects.includes(t.project))).map(t => ({ id: t.id, project: t.project, title: t.title, state: t.state, instruction: t.instruction, revision: t.revision })) };
    });
    if ('reply' in snapshot) return { kind: 'reply', text: snapshot.reply! };
    if ('result' in snapshot) return snapshot.result!;
    const task = snapshot.task!;
    let decision: RouterDecision;
    try {
      decision = routerDecision.parse(await this.provider.decide({ conversationId: input.conversation, message: text, projects: input.projects, task, shared: snapshot.shared! }, AbortSignal.timeout(120000), stage => progress(stage)));
    } catch { progress('failed', '模型分析失败，尚未派发；请稍后重试。'); return { kind: 'reply', text: 'Router 暂时无法完成分析，需求已保留，尚未派发执行。请稍后重试；鉴权请使用现有登录通道，不要发送密钥。' }; }
    progress('validating');
    return this.transaction(ledger => {
      let current = ledger.tasks.find(t => t.id === task.id)!;
      if (current.revision !== task.revision) return { kind: 'reply', text: '需求版本已变化，本次分析未派发，请重新确认。' };
      current.seen.push(input.messageId); current.revision++;
      if (decision.targetTaskId) {
        const target = ledger.tasks.find(t => t.id === decision.targetTaskId && t.owner === input.owner && (!t.project || input.projects.includes(t.project)));
        if (!target) return { kind: 'reply', text: '无法关联该任务：任务不存在或不在当前授权项目内。' };
        target.conversations = [...new Set([target.conversation, ...(target.conversations ?? []), input.conversation])];
        target.sources ??= []; target.sources.push({ conversation: input.conversation, messageId: input.messageId, relation: decision.action === 'propose' ? 'supplement' : 'query' });
        if (decision.action !== 'propose') {
          if (snapshot.previousState === 'proposed') current.state = 'proposed';
          current.history.push({ role: 'assistant', text: `已关联任务 ${target.id}，权威状态 ${target.state}` });
          return { kind: 'reply', text: `${decision.message}\n\n任务：${target.title}｜${target.id}\n账本状态：${target.state}` };
        }
        if (!['collecting', 'proposed'].includes(target.state)) return { kind: 'reply', text: '原任务已经派发，本次不会覆盖已批准范围；新需求请明确作为独立任务。' };
        if (target.id !== current.id) {
          const prior = snapshot.shared?.find(t => t.id === target.id);
          if (!prior || prior.revision !== target.revision) return { kind: 'reply', text: '目标任务版本已变化，请重新补充并确认。' };
          target.revision++; target.seen.push(input.messageId);
          target.history.push({ role: 'user', text: text.slice(0, 32000) });
          current = target;
        }
      }
      if (decision.action === 'propose') {
        const proposals = decision.proposals ?? [{ title: decision.title, project: decision.project, instruction: decision.instruction, isolated: decision.isolated }];
        if (proposals.some(p => !input.projects.includes(p.project) || !p.title.trim() || !p.instruction.trim())) return { kind: 'reply', text: '请明确授权项目、任务标题和可验收需求；本次方案未创建。' };
        if (!['collecting', 'proposed'].includes(current.state)) return { kind: 'reply', text: '执行中的范围变更不会覆盖已批准需求。' };
        if (decision.newTask && snapshot.previousState === 'proposed') { current.state = 'proposed'; }
        const created = proposals.map((proposal, index) => {
          const t = index === 0 && !decision.newTask ? current : { ...structuredClone(current), id: randomUUID(), revision: 1, history: current.history.filter(h => h.role === 'user').slice(-1), attempt: undefined, attempts: [], sources: [{ conversation: input.conversation, messageId: input.messageId, relation: 'input' }], conversations: [input.conversation], conversation: input.conversation };
          if (t !== current) ledger.tasks.push(t);
          t.state = 'proposed'; t.project = proposal.project; t.title = proposal.title; t.instruction = proposal.instruction; t.isolated = proposal.isolated === true;
          t.proposalId = randomUUID(); t.proposalRevision = t.revision;
          t.history.push({ role: 'assistant', text: `方案已提交：${t.title} (${t.id})` });
          return `任务：${t.title}\nID：${t.id}｜版本 v${t.proposalRevision}\n项目：${t.project}\n执行目录：${t.isolated ? '独立临时任务目录（不进入项目 checkout）' : '项目 checkout（共享写入互斥）'}\n${t.instruction}\n\n回复「批准执行 ${t.id} v${t.proposalRevision}」确认该方案；「取消任务 ${t.id}」取消。`;
        });
        return { kind: 'reply', text: `${decision.message}\n\n${created.join('\n\n---\n\n')}\n\n只有一个待确认方案时，也可回复「批准执行」。可继续在本窗口提出其他需求。` };
      }
      if (decision.action === 'reply' && snapshot.previousState === 'proposed') { current.state = 'proposed'; }
      current.history.push({ role: 'assistant', text: decision.message });
      if (decision.action === 'continue') {
        // A semantic judgement is not host-verifiable execution authorization.
        return { kind: 'reply', text: '补充信息已保留。首版不自动将新消息注入运行任务；若执行正在等待问答，请回复原问题。范围变更请先核查原任务并另开话题。' };
      }
      return { kind: 'reply', text: decision.message || '请补充目标项目、需求和验收条件。' };
    });
  }
  async reconcile(executions: NonNullable<RouterInput['execution']>[]): Promise<void> {
    await this.transaction(ledger => {
      for (const task of ledger.tasks.filter(t => t.state === 'running')) {
        const facts = executions.find(e => e.sessionId === task.attempt?.sessionId);
        const next = !facts || facts.closed || facts.interrupted ? 'blocked'
          : facts.delivered && facts.turnId === task.attempt?.turnId && !facts.busy && !facts.waiting ? 'review' : 'running';
        if (task.state !== next) { task.state = next; task.revision++; }
      }
    });
  }
  async bind(attemptId: string, sessionId: string): Promise<void> {
    await this.transaction(ledger => {
      const task = ledger.tasks.find(t => t.attempt?.id === attemptId);
      if (!task || task.state !== 'dispatching') throw new Error('router_dispatch_stale');
      if (task.attempt!.sessionId && task.attempt!.sessionId !== sessionId) throw new Error('router_dispatch_identity_mismatch');
      task.attempt!.sessionId = sessionId; task.revision++;
    });
  }
  async finish(attemptId: string, sessionId: string | undefined, accepted: boolean): Promise<void> {
    await this.transaction(ledger => {
      const task = ledger.tasks.find(t => t.attempt?.id === attemptId);
      if (!task || task.state !== 'dispatching') return;
      if (accepted && sessionId) { task.state = 'running'; task.attempt!.sessionId = sessionId; task.revision++; }
      // Otherwise dispatching intentionally survives. No blind replay.
    });
  }
}
