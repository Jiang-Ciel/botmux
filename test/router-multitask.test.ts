import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DefaultRouter, type RouterDecision, type RouterInput } from '../src/services/default-router.js';
import { activeSessionKey, sessionAnchorId, type DaemonSession } from '../src/core/types.js';
import { listRouterProgress, interruptRouterProgress, routerProgressCard } from '../src/services/router-progress.js';
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'router-multi-')); const project = join(root, 'project'); mkdirSync(project);
  const decide = vi.fn(async (): Promise<RouterDecision> => ({ action: 'propose', requiresApproval: true, title: '北京天气', message: '方案就绪', project, instruction: '查询北京天气', isolated: true }));
  const router = new DefaultRouter(root, { decide });
  const input: RouterInput = { conversation: 'window', owner: 'app:owner', messageId: 'beijing', text: '北京天气', projects: [project], executions: [] };
  const tasks = () => JSON.parse(readFileSync(join(root, 'ledger.json'), 'utf8')).tasks;
  return { root, project, decide, router, input, tasks };
}
describe('duplex multi-task router', () => {
  it('routes Nanjing while Beijing runs and retains matching source prompts', async () => {
    const f = setup(); await f.router.handle(f.input); const a = f.tasks()[0];
    const first = await f.router.handle({ ...f.input, messageId: 'approve-a', text: `批准执行 ${a.id} v${a.proposalRevision}` });
    if (first.kind !== 'dispatch') throw new Error('dispatch missing');
    await f.router.finish(first.attemptId, 's-a', true);
    f.decide.mockResolvedValueOnce({ action: 'propose', requiresApproval: true, message: '南京方案', newTask: true, title: '南京天气', project: f.project, instruction: '查询南京天气', isolated: true });
    const executions = [{ sessionId: 's-a', busy: true, waiting: false, closed: false, interrupted: false, delivered: false }];
    await f.router.handle({ ...f.input, messageId: 'nanjing', text: '保留北京，另查南京', executions });
    const b = f.tasks().find((t: any) => t.title === '南京天气'); expect(b.id).not.toBe(a.id);
    const second = await f.router.handle({ ...f.input, messageId: 'approve-b', text: `批准执行 ${b.id} v${b.proposalRevision}`, executions });
    if (second.kind !== 'dispatch') throw new Error('second dispatch missing');
    expect(second.project).not.toBe(first.project); expect(second.sourceMessageId).toBe('nanjing'); expect(first.sourceMessageId).toBe('beijing');
    expect(f.tasks()[0].state).toBe('running');
  });
  it('splits one prompt into multiple proposals and asks for an explicit approval target', async () => {
    const f = setup(); f.decide.mockResolvedValueOnce({ action: 'propose', requiresApproval: true, message: '双方案', title: '天气', project: f.project, instruction: '查天气',
      proposals: ['北京', '南京'].map(city => ({ title: city, project: f.project, instruction: `查${city}`, isolated: true })) });
    await f.router.handle(f.input); expect(f.tasks()).toHaveLength(2);
    const reply = await f.router.handle({ ...f.input, messageId: 'approve', text: '批准执行' });
    expect(reply.kind).toBe('reply'); expect((reply as any).text).toContain('指定任务');
    expect(f.tasks().every((t: any) => t.state === 'proposed')).toBe(true);
  });
  it('preserves an unrelated proposal and its approval version when creating a new one', async () => {
    const f = setup(); await f.router.handle(f.input); const a = f.tasks()[0];
    f.decide.mockResolvedValueOnce({ action: 'propose', requiresApproval: true, message: '另建南京', title: '南京', project: f.project, instruction: '南京天气', isolated: true, newTask: true });
    await f.router.handle({ ...f.input, messageId: 'b', text: '另查南京' });
    const stored = f.tasks().find((t: any) => t.id === a.id); expect(stored.state).toBe('proposed'); expect(stored.proposalRevision).toBe(a.proposalRevision);
    expect((await f.router.handle({ ...f.input, messageId: 'approve', text: `批准执行 ${a.id} v${a.proposalRevision}` })).kind).toBe('dispatch');
  });
  it('links an authorized task across windows but rejects another owner target', async () => {
    const f = setup(); await f.router.handle(f.input); const a = f.tasks()[0];
    f.decide.mockResolvedValueOnce({ action: 'reply', message: '查询状态', title: '', project: '', instruction: '', targetTaskId: a.id });
    await f.router.handle({ ...f.input, conversation: 'window-2', messageId: 'query', text: '北京怎么样了' });
    expect(f.tasks()[0].conversations).toEqual(['window', 'window-2']); expect(f.tasks()[0].state).toBe('proposed');
    const denied = await f.router.handle({ ...f.input, owner: 'app:other', messageId: 'bad', text: `批准执行 ${a.id}` });
    expect(denied.kind).toBe('reply'); expect(f.tasks()[0].state).toBe('proposed');
  });
  it('does not store a rejected proposal as an accepted fact', async () => {
    const f = setup(); f.decide.mockResolvedValueOnce({ action: 'propose', requiresApproval: true, message: '已开始南京', title: '南京', project: '/unapproved', instruction: 'go' });
    await f.router.handle(f.input); expect(f.tasks()[0].history.some((h: any) => h.text === '已开始南京')).toBe(false);
  });
  it('rejects stale proposal approval after a revision', async () => {
    const f = setup(); await f.router.handle(f.input); const old = f.tasks()[0];
    await f.router.handle({ ...f.input, messageId: 'edit', text: '改查明天' });
    const reply = await f.router.handle({ ...f.input, messageId: 'approve', text: `批准执行 ${old.id} v${old.proposalRevision}` });
    expect(reply.kind).toBe('reply'); expect((reply as any).text).toContain('版本已变化');
  });
  it('does not let an idle review task block a new checkout task', async () => {
    const f = setup(); f.decide.mockResolvedValueOnce({ action: 'propose', requiresApproval: true, message: '方案', title: 'A', project: f.project, instruction: 'write' });
    await f.router.handle(f.input); const first = await f.router.handle({ ...f.input, messageId: 'a', text: '批准执行' });
    if (first.kind !== 'dispatch') throw new Error('missing'); await f.router.finish(first.attemptId, 's-a', true);
    const executions = [{ sessionId: 's-a', busy: false, waiting: false, closed: false, interrupted: false, delivered: true, turnId: 'a' }];
    f.decide.mockResolvedValueOnce({ action: 'propose', requiresApproval: true, message: 'B', newTask: true, title: 'B', project: f.project, instruction: 'write B' });
    await f.router.handle({ ...f.input, messageId: 'b', text: '另做B', executions });
    expect((await f.router.handle({ ...f.input, messageId: 'approve-b', text: '批准执行', executions })).kind).toBe('dispatch');
    expect(f.tasks()[0].state).toBe('review');
  });
  it('rebuilds independent runtime identities without changing the shared visible route', () => {
    const base = { larkAppId: 'app', chatId: 'oc_chat', scope: 'chat', session: { sessionId: 's1', chatId: 'oc_chat', scope: 'chat', rootMessageId: 'om_seed', routerTask: { taskId: 't1' } } } as unknown as DaemonSession;
    const other = { ...base, session: { ...base.session, sessionId: 's2', routerTask: { ...base.session.routerTask!, taskId: 't2' } } };
    expect(activeSessionKey(base)).not.toBe(activeSessionKey(other)); expect(sessionAnchorId(base)).toBe(sessionAnchorId(other));
    expect(activeSessionKey({ ...base, session: JSON.parse(JSON.stringify(base.session)) })).toBe(activeSessionKey(base));
  });
  it('records truthful progress and terminates failed analysis without exposing raw error', async () => {
    const f = setup(); const events: string[] = [];
    f.decide.mockImplementationOnce(async (...args: any[]) => { const onProgress = args[2]; return (async () => { onProgress?.('submitted'); onProgress?.('analyzing'); throw new Error('SECRET thinking'); })(); });
    await f.router.handle({ ...f.input, onProgress: p => events.push(p.stage) });
    const p = listRouterProgress(f.root)[0]; expect(events).toEqual(['queued', 'context', 'submitted', 'analyzing', 'failed']); expect(p.finishedAt).toBeTypeOf('number');
    expect(JSON.stringify(p)).not.toContain('SECRET'); expect(JSON.stringify(routerProgressCard(p))).not.toContain('SECRET');
  });
  it('reconciles Beijing delivery independently while Nanjing analysis is waiting', async () => {
    const f = setup(); await f.router.handle(f.input);
    const first = await f.router.handle({ ...f.input, messageId: 'approve', text: '批准执行' });
    if (first.kind !== 'dispatch') throw new Error('missing'); await f.router.finish(first.attemptId, 'session-a', true);
    let release!: (d: RouterDecision) => void;
    f.decide.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const pending = f.router.handle({ ...f.input, messageId: 'nanjing', text: '南京天气', executions: [{ sessionId: 'session-a', busy: true, waiting: false, closed: false, interrupted: false, delivered: false }] });
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    await f.router.reconcile([{ sessionId: 'session-a', busy: false, waiting: false, closed: false, interrupted: false, delivered: true, turnId: 'approve' }]);
    expect(f.tasks()[0].state).toBe('review');
    release({ action: 'propose', requiresApproval: true, title: '南京', message: '方案', project: f.project, instruction: '南京天气', isolated: true }); await pending;
    expect(f.tasks()[0].state).toBe('review'); expect(f.tasks()).toHaveLength(1);
  });
  it('does not allow a failed progress transport to block proposal creation', async () => {
    const f = setup(); await f.router.handle({ ...f.input, onProgress: () => { throw new Error('network'); } }); expect(f.tasks()[0].state).toBe('proposed');
    expect(listRouterProgress(f.root)[0].stage).toBe('completed'); interruptRouterProgress(f.root, f.input.owner); expect(listRouterProgress(f.root)[0].stage).toBe('completed');
  });
});
