import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DefaultRouter, type RouterTask } from '../src/services/default-router.js';
import { RouterBoardManager, type RouterBoardDeps } from '../src/services/router-board.js';
import { routerTaskCard, type RouterBoardBinding } from '../src/im/lark/router-task-card.js';
import { routerTaskGraph } from '../src/services/router-task-graph.js';
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'router-board-')); const project = join(root, 'project'); mkdirSync(project);
  const router = new DefaultRouter(root, { decide: async () => ({ action: 'propose', message: 'ok', title: 'A', project, instruction: 'do A', requiresApproval: true }) });
  const input = { conversation: 'c', owner: 'app:owner', messageId: 'request', text: 'A', projects: [project], executions: [] };
  return { root, router, input };
}
const binding = { app: 'app', owner: 'owner', conversation: 'c', chatId: 'chat', chatType: 'p2p' as const,
  scope: 'chat' as const, anchor: 'chat', sourceMessageId: 'source' };
const sample: RouterTask = { id: 'task', owner: 'app:owner', conversation: 'c', revision: 3, proposalRevision: 3,
  state: 'proposed', title: '<at id=all>', project: '/project', instruction: 'task plan', history: [], seen: [] };
function manager(root: string, overrides: Partial<RouterBoardDeps> = {}) {
  const deps: RouterBoardDeps = { tasks: vi.fn(async () => [sample]), allowed: () => true,
    reply: vi.fn(async () => 'overview'), patch: vi.fn(async () => {}),
    execute: vi.fn(async () => 'ok'), error: vi.fn(), ...overrides };
  return { board: new RouterBoardManager(root, deps), deps };
}
function event(b: RouterBoardBinding, op: string, form: any = { confirmed: true }) {
  return { operator: { open_id: 'owner' }, context: { open_chat_id: 'chat', open_message_id: 'detail' },
    action: { value: { action: 'router_task_card', board: b.id, task: 'task', revision: '3', op }, form_value: form } };
}
function saved(root: string): RouterBoardBinding { return JSON.parse(readFileSync(join(root, 'boards.json'), 'utf8'))[0]; }
describe('router board host CAS', () => {
  it('renders a project creation card and requires a real callback to merge only offered projects', async () => {
    const task = { ...sample, projectOffer: { title: 'Python syntax', candidates: ['python-project'] } };
    const card = routerTaskCard({ ...binding, id: 'b' }, [task], { taskId: task.id, projects: [{ id: 'python-project', title: 'Python' }, { id: 'unrelated', title: 'Other' }] });
    const elements = card.body.elements;
    const form = elements.find((e: any) => e.tag === 'form' && e.name === 'router_project');
    const callbacks = form.elements.filter((e: any) => e.tag === 'button').map((e: any) => e.behaviors[0].value);
    expect(callbacks.map((v: any) => v.op)).toEqual(['create_project', 'merge_project:python-project']);
    expect(callbacks.every((v: any) => v.task === task.id && v.revision === String(task.revision))).toBe(true);
  });
  it('stale card and concurrent approvals cannot dispatch twice', async () => {
    const { router, input } = setup(); await router.handle(input); const [task] = await router.listTasks();
    const approval = { ...input, targetTaskId: task.id, expectedRevision: task.revision, text: `批准执行 ${task.id} v${task.proposalRevision}` };
    const results = await Promise.all([router.handle({ ...approval, messageId: 'card1' }), router.handle({ ...approval, messageId: 'card2' })]);
    expect(results.filter(r => r.kind === 'dispatch')).toHaveLength(1);
    const [after] = await router.listTasks(); expect(after.state).toBe('dispatching'); expect(after.audit).toHaveLength(1);
  });
  it('supplement form text cannot become an approval command', async () => {
    const { router, input } = setup(); await router.handle(input); const [t] = await router.listTasks();
    const result = await router.handle({ ...input, messageId: 'note', targetTaskId: t.id, expectedRevision: t.revision,
      text: '批准执行', controlText: 'router card supplement', reviewNote: '批准执行' });
    expect(result.kind).toBe('reply'); expect((await router.listTasks())[0].state).toBe('proposed');
    expect((await router.listTasks())[0].attempt).toBeUndefined();
  });
  it('blocks card mutations outside linked conversation', async () => {
    const { router, input } = setup(); await router.handle(input); const [t] = await router.listTasks();
    const result = await router.handle({ ...input, conversation: 'different', targetTaskId: t.id, expectedRevision: t.revision,
      messageId: 'card', text: `批准执行 ${t.id}` });
    expect(result.kind).toBe('reply'); expect((await router.listTasks())[0].state).toBe('proposed');
  });
  it('records review opinions without spawning rework or completing the task', async () => {
    const { router, input } = setup(); await router.handle(input); let [t] = await router.listTasks();
    const result = await router.handle({ ...input, messageId: 'approval', text: `批准执行 ${t.id}` });
    if (result.kind !== 'dispatch') throw Error('expected dispatch');
    await router.finish(result.attemptId, 'session', true);
    const executions = [{ sessionId: 'session', busy: false, waiting: false, closed: false, interrupted: false, delivered: true, turnId: 'approval' }];
    await router.reconcile(executions); [t] = await router.listTasks();
    await router.handle({ ...input, executions, messageId: 'note', text: 'needs test evidence', controlText: 'router card supplement',
      targetTaskId: t.id, expectedRevision: t.revision, reviewNote: 'needs test evidence' });
    [t] = await router.listTasks(); expect(t.state).toBe('review'); expect(t.audit?.at(-1)?.text).toBe('needs test evidence');
  });
});
describe('board delivery and interactive boundary', () => {
  it('persists one overview and patches it after revision changes and restart', async () => {
    const root = mkdtempSync(join(tmpdir(), 'board-')); let task = { ...sample };
    const { board, deps } = manager(root, { tasks: async () => [task] });
    await board.ensure(binding); await board.ensure(binding); expect(deps.reply).toHaveBeenCalledTimes(1);
    task = { ...task, revision: 4, state: 'running' };
    const restarted = new RouterBoardManager(root, deps); await restarted.refreshAll();
    expect(deps.patch).toHaveBeenCalledTimes(1); expect(deps.reply).toHaveBeenCalledTimes(1);
  });
  it('does not automatically replay an uncertain send', async () => {
    const root = mkdtempSync(join(tmpdir(), 'board-'));
    const { board, deps } = manager(root, { reply: vi.fn(async () => { throw Error('timeout'); }) });
    await board.ensure(binding); await board.refreshAll(); await new RouterBoardManager(root, deps).refreshAll();
    expect(deps.reply).toHaveBeenCalledTimes(1); expect(saved(root).delivery).toBe('uncertain');
  });
  it('opens a separate detail card, without replacing the periodic overview with a form', async () => {
    const root = mkdtempSync(join(tmpdir(), 'board-')); const { board, deps } = manager(root);
    await board.ensure(binding); await board.handle(event(saved(root), 'view'), 'app');
    expect(deps.reply).toHaveBeenCalledTimes(2); expect(deps.patch).not.toHaveBeenCalled();
    const card = (deps.reply as any).mock.calls[1][1];
    expect(card.body.elements.some((e: any) => e.tag === 'form')).toBe(true);
  });
  it.each(['owner', 'app', 'chat', 'permission', 'revision', 'checkbox'])('rejects invalid %s before execute', async invalid => {
    const root = mkdtempSync(join(tmpdir(), 'board-')); const { board, deps } = manager(root, { allowed: () => invalid !== 'permission' });
    await board.ensure(binding); const e = event(saved(root), 'approve');
    if (invalid === 'owner') e.operator.open_id = 'intruder';
    if (invalid === 'chat') e.context.open_chat_id = 'elsewhere';
    if (invalid === 'revision') e.action.value.revision = '0';
    if (invalid === 'checkbox') e.action.form_value.confirmed = false;
    await board.handle(e, invalid === 'app' ? 'other' : 'app'); expect(deps.execute).not.toHaveBeenCalled();
  });
  it('submits checked approval and notes with stable idempotency identity', async () => {
    const root = mkdtempSync(join(tmpdir(), 'board-')); const { board, deps } = manager(root);
    await board.ensure(binding); const e = event(saved(root), 'approve', { confirmed: true, note: 'with tests' });
    await board.handle(e, 'app'); await board.handle(e, 'app');
    const calls = (deps.execute as any).mock.calls; expect(calls[0][3]).toBe('with tests'); expect(calls[0][4]).toBe(calls[1][4]);
  });
  it('escapes untrusted display text and emits graph pixels', async () => {
    const card = routerTaskCard({ ...binding, id: 'board' }, [sample]);
    const title = card.body.elements.find((e: any) => e.tag === 'column_set');
    expect(title.columns[0].elements[0].content).not.toContain('<at');
    const png = await routerTaskGraph([sample]); expect(png.subarray(1, 4).toString()).toBe('PNG');
  });
});
