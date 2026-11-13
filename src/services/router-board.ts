import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWriteFileSync } from '../utils/atomic-write.js';
import { normalizeCardActionData } from '../im/lark/card-action-data.js';
import { routerTaskCard, type RouterBoardBinding } from '../im/lark/router-task-card.js';
import type { RouterTask } from './default-router.js';
export interface RouterBoardDeps {
  /** One daemon per bot. Namespaced sidecars prevent cross-bot read-modify-write loss. */
  namespace?(): string | undefined;
  tasks(b: RouterBoardBinding): Promise<RouterTask[]>;
  projects?(b: RouterBoardBinding): Promise<Array<{ id: string; title: string }>>;
  allowed(b: RouterBoardBinding, openId: string, unionId?: string): boolean;
  reply(b: RouterBoardBinding, card: unknown, uuid: string): Promise<string>;
  patch(b: RouterBoardBinding, card: unknown): Promise<void>;
  graph?(tasks: RouterTask[], app: string): Promise<string>;
  tools?(task: RouterTask): Array<{ name: string; subject?: string; completed?: boolean }>;
  execute(b: RouterBoardBinding, task: RouterTask, op: string, note: string, eventId: string): Promise<string>;
  error(error: unknown): void;
}
/** Sidecar is only presentation transport, never an execution authority. An uncertain initial
 * send is not replayed; explicit new user input can create a fresh board. Details are separate
 * cards, so the periodic overview PATCH cannot destroy an unsent form. */
export class RouterBoardManager {
  private bindings = new Map<string, RouterBoardBinding>();
  private work = new Map<string, Promise<unknown>>();
  private loadedPath?: string;
  constructor(private root: string, private deps: RouterBoardDeps) {
    mkdirSync(root, { recursive: true, mode: 0o700 });
  }
  private load() {
    const namespace = this.deps.namespace?.();
    if (this.deps.namespace && !namespace) return false;
    const path = join(this.root, namespace ? `boards-${createHash('sha256').update(namespace).digest('hex')}.json` : 'boards.json');
    if (path === this.loadedPath) return true;
    this.bindings.clear();
    try { for (const b of JSON.parse(readFileSync(path, 'utf8'))) this.bindings.set(b.id, b); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
    this.loadedPath = path; return true;
  }
  private save() { atomicWriteFileSync(this.loadedPath!, JSON.stringify([...this.bindings.values()]), { durable: true, mode: 0o600 }); }
  private serial<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const prior = this.work.get(id) ?? Promise.resolve();
    const next = prior.catch(() => {}).then(fn); this.work.set(id, next);
    void next.finally(() => { if (this.work.get(id) === next) this.work.delete(id); }).catch(() => {});
    return next;
  }
  async ensure(input: Omit<RouterBoardBinding, 'id' | 'hash' | 'messageId' | 'delivery'>): Promise<void> {
    if (!this.load() || (this.deps.namespace && this.deps.namespace() !== input.app)) return;
    const id = createHash('sha256').update(JSON.stringify([input.app, input.owner, input.conversation])).digest('hex');
    await this.serial(id, async () => {
      let b = this.bindings.get(id);
      if (b?.delivery === 'pending') { b.delivery = 'uncertain'; this.save(); }
      if (!b || b.delivery === 'uncertain') {
        b = { ...input, id, delivery: 'pending' }; this.bindings.set(id, b); this.save();
        try {
          const tasks = await this.deps.tasks(b);
          const imageKey = await this.deps.graph?.(tasks, b.app).catch(this.deps.error);
          const card = routerTaskCard(b, tasks, { imageKey: imageKey || undefined });
          b.messageId = await this.deps.reply(b, card, randomUUID());
          b.delivery = 'active'; b.hash = this.hash(tasks); this.save();
        } catch (error) { b.delivery = 'uncertain'; this.save(); this.deps.error(error); }
      } else await this.paint(b);
    });
  }
  private hash(tasks: RouterTask[]) { return createHash('sha256').update(JSON.stringify(tasks.map(t => [t.id, t.revision, t.state]))).digest('hex'); }
  private async paint(b: RouterBoardBinding, force = false) {
    if (b.delivery !== 'active' || !b.messageId) return;
    const tasks = await this.deps.tasks(b); const hash = this.hash(tasks);
    if (!force && hash === b.hash) return;
    const imageKey = await this.deps.graph?.(tasks, b.app).catch(this.deps.error);
    await this.deps.patch(b, routerTaskCard(b, tasks, { imageKey: imageKey || undefined }));
    b.hash = hash; this.save();
  }
  async offerProject(input: Omit<RouterBoardBinding, 'id' | 'hash' | 'messageId' | 'delivery'>) {
    if (!this.load()) return;
    const b = [...this.bindings.values()].find(b => b.app === input.app && b.owner === input.owner && b.conversation === input.conversation);
    if (!b) return;
    const tasks = await this.deps.tasks(b);
    const offer = [...tasks].reverse().find(t => t.projectOffer && t.state !== 'cancelled');
    if (offer) await this.deps.reply(b, routerTaskCard(b, tasks, { taskId: offer.id, projects: await this.deps.projects?.(b) }), randomUUID());
  }
  async refreshAll() {
    if (!this.load()) return;
    await Promise.all([...this.bindings.values()].filter(b => b.delivery === 'active').map(b =>
      this.serial(b.id, () => this.paint(b)).catch(this.deps.error)));
  }
  async handle(input: unknown, app?: string): Promise<unknown | undefined> {
    const data = normalizeCardActionData(input); const v = data.action?.value;
    if (v?.action !== 'router_task_card') return undefined;
    if (!this.load()) return { toast: { type: 'error', content: '服务身份尚未就绪，请稍后重试。' } };
    const toast = (content: string) => ({ toast: { type: 'info', content } });
    const b = this.bindings.get(v.board); const operator = data.operator?.open_id;
    if (!b || app !== b.app || !operator || operator !== b.owner
      || data.context?.open_chat_id !== b.chatId || !this.deps.allowed(b, operator, data.operator?.union_id))
      return toast('卡片已失效或你无权操作此任务。');
    return this.serial(b.id, async () => {
      if (!this.deps.allowed(b, operator, data.operator?.union_id)) return toast('操作权限已变化。');
      const tasks = await this.deps.tasks(b); const task = tasks.find(t => t.id === v.task);
      if (v.op === 'refresh') { await this.paint(b, true); return toast('已刷新任务总览'); }
      if (!task) return toast('任务已不存在或不属于当前窗口。');
      if (v.op === 'view') {
        await this.deps.reply(b, routerTaskCard(b, tasks, { taskId: task.id, tools: this.deps.tools?.(task), projects: await this.deps.projects?.(b) }), randomUUID());
        return toast('已发送独立节点详情卡，可在卡片中审核');
      }
      if (!['approve', 'cancel', 'accept', 'supplement', 'create_project', 'direct_task'].includes(v.op) && !v.op.startsWith('merge_project:')) return toast('不支持该操作');
      if (Number(v.revision) !== task.revision) return toast('节点状态已变化，请刷新节点详情后重新确认。');
      const form = data.action?.form_value; const note = typeof form?.note === 'string' ? form.note.trim() : '';
      if (['approve', 'accept'].includes(v.op) && form?.confirmed !== true) return toast('请先勾选确认项，再提交。');
      if (v.op === 'supplement' && !note) return toast('请填写补充信息或修改意见');
      if (note.length > 4000) return toast('补充信息过长');
      const eventId = (data as any).event_id ?? (data as any).header?.event_id;
      // Stable per rendered revision: duplicate callback delivery cannot dispatch twice.
      const id = `card:${eventId ?? createHash('sha256').update(JSON.stringify([b.id, task.id, v.revision, v.op, note])).digest('hex')}`;
      if (!this.deps.allowed(b, operator, data.operator?.union_id)) return toast('操作权限已变化。');
      const notice = await this.deps.execute(b, task, v.op, note, id);
      const updated = await this.deps.tasks(b);
      await this.deps.reply(b, routerTaskCard(b, updated, { taskId: task.id, notice, tools: this.deps.tools?.(updated.find(t => t.id === task.id) ?? task) }), randomUUID());
      await this.paint(b);
      return toast('操作已处理，请查看最新节点卡。');
    });
  }
}
