import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { atomicWriteFileSync } from '../utils/atomic-write.js';
import { withExclusiveFileLock } from '../utils/file-flock.js';
import type { DaemonSession } from '../core/types.js';

export const routerDecision = z.object({
  action: z.enum(['clarify', 'propose', 'reply', 'continue']),
  message: z.string().max(12000),
  title: z.string().min(1).max(160),
  project: z.string().max(4096),
  instruction: z.string().max(32000),
}).strict();
export type RouterDecision = z.infer<typeof routerDecision>;
export interface RouterProvider { decide(context: RouterContext, signal: AbortSignal): Promise<RouterDecision> }
export interface RouterContext {
  conversationId: string;
  message: string;
  projects: string[];
  task: RouterTask;
  shared: Array<Pick<RouterTask, 'id' | 'project' | 'title' | 'state' | 'instruction'>>;
}
export interface RouterTask {
  id: string;
  conversation: string;
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
export type RouterResult = { kind: 'reply'; text: string } | { kind: 'dispatch'; instruction: string; project: string; attemptId: string };
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
    const previous = this.queues.get(input.conversation) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(() => this.handleSerial(input));
    this.queues.set(input.conversation, next);
    try { return await next; } finally { if (this.queues.get(input.conversation) === next) this.queues.delete(input.conversation); }
  }
  private async handleSerial(input: RouterInput): Promise<RouterResult> {
    const text = input.text.trim();
    const control = (input.controlText ?? input.text).trim();
    const snapshot = await this.transaction(ledger => {
      let task = ledger.tasks.find(t => t.conversation === input.conversation && t.owner === input.owner);
      if (!task) {
        task = { id: randomUUID(), conversation: input.conversation, owner: input.owner, revision: 0, state: 'collecting', title: '', project: '', instruction: '', history: [], seen: [] };
        ledger.tasks.push(task);
      }
      if (task.seen.includes(input.messageId)) return { reply: '这条消息已接收，请勿重复发送。' };
      // An unknown dispatch stays fenced, even after restart or manual close.
      if (task.state === 'dispatching') return { reply: '上次派发结果尚未核实，已保留项目写入栅栏；请先核查执行会话，不会自动重发。' };
      const priorState = task.state;
      if (task.state === 'running' && (!input.execution || task.attempt?.sessionId !== input.execution.sessionId)) task.state = 'blocked';
      if (task.state === 'running' && task.attempt?.sessionId === input.execution?.sessionId) {
        if (input.execution?.closed || input.execution?.interrupted) task.state = 'blocked';
        else if (input.execution?.delivered && input.execution.turnId === task.attempt?.turnId
          && !input.execution.busy && !input.execution.waiting) task.state = 'review';
      }
      if (task.state !== priorState) task.revision++;
      if (/^(取消任务|cancel task)$/i.test(control)) {
        if (!['collecting', 'proposed', 'cancelled', 'completed'].includes(task.state)) return { reply: '执行可能仍有副作用，请先在执行会话停止并核查；Router 不会仅凭取消消息释放写入栅栏。' };
        task.state = 'cancelled'; task.revision++; task.seen.push(input.messageId);
        return { reply: '已取消尚未派发的任务。新任务请另开话题。' };
      }
      if (/^(验收完成|accept task)$/i.test(control) && task.state === 'review' && input.execution
        && input.execution.sessionId === task.attempt?.sessionId && !input.execution.busy && !input.execution.waiting
        && input.execution.delivered && input.execution.turnId === task.attempt?.turnId) {
        task.state = 'completed'; task.revision++; task.seen.push(input.messageId);
        return { reply: '任务已验收完成。新任务请另开话题。' };
      }
      if (task.state === 'cancelled' || task.state === 'completed') return { reply: '此任务已结束，新任务请另开话题。' };
      const claim = (instruction: string): RouterResult => {
        if (!task!.project || !input.projects.includes(task!.project)) return { kind: 'reply', text: '目标项目不在当前允许的项目列表中，请重新确认项目。' };
        if (input.execution?.busy || input.projectBusy?.(task!.project)
          || ledger.tasks.some(t => t.id !== task!.id && t.project === task!.project && ['dispatching', 'running', 'blocked', 'review'].includes(t.state))) {
          return { kind: 'reply', text: '该项目或执行会话仍被占用，请等待完成并验收；不会并发写入同一 checkout。' };
        }
        const attemptId = randomUUID();
        task!.state = 'dispatching'; task!.revision++; task!.seen.push(input.messageId);
        task!.attempt = { id: attemptId, turnId: input.messageId, sessionId: input.execution?.sessionId };
        return { kind: 'dispatch', instruction, project: task!.project, attemptId };
      };
      if (/^(批准执行|approve task)$/i.test(control) && task.state === 'proposed') return { result: claim(task.instruction) };
      if (task.state === 'blocked') return { reply: '任务中断或会话已关闭，项目栅栏仍保留。请核查执行状态后使用现有受控恢复通道；不会盲目重跑。' };
      // Any edit invalidates a prior proposal before inference, including failure.
      if (task.state === 'proposed') task.state = 'collecting';
      task.history.push({ role: 'user', text: text.slice(0, 32000) }); task.history = task.history.slice(-24); task.revision++;
      return { task: structuredClone(task), shared: ledger.tasks.filter(t => t.owner === input.owner && t.project && input.projects.includes(t.project)).map(t => ({ id: t.id, project: t.project, title: t.title, state: t.state, instruction: t.instruction })) };
    });
    if ('reply' in snapshot) return { kind: 'reply', text: snapshot.reply! };
    if ('result' in snapshot) return snapshot.result!;
    const task = snapshot.task!;
    let decision: RouterDecision;
    try {
      decision = routerDecision.parse(await this.provider.decide({ conversationId: input.conversation, message: text, projects: input.projects, task, shared: snapshot.shared! }, AbortSignal.timeout(120000)));
    } catch { return { kind: 'reply', text: 'Router 暂时无法完成分析，需求已保留，尚未派发执行。请稍后重试；鉴权请使用现有登录通道，不要发送密钥。' }; }
    return this.transaction(ledger => {
      const current = ledger.tasks.find(t => t.id === task.id)!;
      if (current.revision !== task.revision) return { kind: 'reply', text: '需求版本已变化，本次分析未派发，请重新确认。' };
      current.seen.push(input.messageId); current.revision++;
      current.history.push({ role: 'assistant', text: decision.message });
      if (decision.action === 'propose') {
        if (!['collecting', 'proposed'].includes(current.state)) return { kind: 'reply', text: '执行中的范围变更需先停止并核查原任务；本次不会覆盖已批准需求。' };
        if (!input.projects.includes(decision.project) || !decision.instruction.trim()) return { kind: 'reply', text: '请明确目标项目和可验收的需求，Router 不会选择未授权目录。' };
        current.state = 'proposed'; current.project = decision.project; current.title = decision.title; current.instruction = decision.instruction;
        return { kind: 'reply', text: `${decision.message}\n\n项目：${current.project}\n任务：${current.title}\n\n${current.instruction}\n\n回复「批准执行」开始，或直接补充/修改需求。「取消任务」取消。` };
      }
      if (decision.action === 'continue') {
        // A semantic judgement is not host-verifiable execution authorization.
        return { kind: 'reply', text: '补充信息已保留。首版不自动将新消息注入运行任务；若执行正在等待问答，请回复原问题。范围变更请先核查原任务并另开话题。' };
      }
      return { kind: 'reply', text: decision.message || '请补充目标项目、需求和验收条件。' };
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
