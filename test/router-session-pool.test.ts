import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { RouterSessionPool } from '../src/services/router-session-pool.js';
import { routerExecutionFacts, type RouterDecision, type RouterInput } from '../src/services/default-router.js';

async function setup(size = 4) {
  const root = mkdtempSync(join(tmpdir(), 'router-pool-test-')); const project = join(root, 'repo'); mkdirSync(project);
  const decide = vi.fn(async (): Promise<RouterDecision> => ({ action: 'propose', title: 'Python syntax', project, instruction: 'correct full code', message: '- output full code', isolated: true }));
  const pool = new RouterSessionPool(root, { decide });
  const slots = await pool.reserveSlots('app:owner', size);
  const executions: NonNullable<RouterInput['execution']>[] = [];
  for (const [index, slot] of slots.entries()) {
    await pool.bindSlot(slot.id, slot.owner, `s${index}`, pool.slotDirectory(slot.owner, slot.id));
    executions.push({ sessionId: `s${index}`, busy: false, waiting: false, closed: false, interrupted: false, delivered: false });
  }
  const input = { conversation: 'chat', owner: 'app:owner', messageId: 'original', text: 'from datetime imprt datetime\n dt=datetime()\nprint(dt)', projects: [project], executions };
  return { root, project, decide, pool, input, slots, executions };
}
async function dispatch(f: Awaited<ReturnType<typeof setup>>) {
  const result = await f.pool.handle(f.input); if (result.kind !== 'dispatch') throw new Error('missing dispatch');
  await f.pool.bind(result.attemptId, result.sessionId!); await f.pool.finish(result.attemptId, result.sessionId, true); return result;
}

describe('persistent pool and iterative conversation projects', () => {
  it('reserves exactly four slots, random idle assignment and closes only the one-shot task', async () => {
    const f = await setup(); expect(f.slots).toHaveLength(4); expect(await f.pool.reserveSlots(f.input.owner)).toEqual([]);
    const result = await dispatch(f); expect(f.executions.some(e => e.sessionId === result.sessionId)).toBe(true);
    const facts = f.executions.map(e => e.sessionId === result.sessionId ? { ...e, delivered: true, turnId: 'original', response: '[BOTMUX_TASK_RESULT] corrected code' } : e);
    await f.pool.reconcile(facts); const [task] = await f.pool.listTasks(); expect(task.state).toBe('completed');
    const restored = new RouterSessionPool(f.root, { decide: f.decide });
    expect(await restored.reserveSlots(f.input.owner)).toEqual([]);
    const next = await restored.handle({ ...f.input, messageId: 'btw', text: 'btw what is weather?', executions: facts });
    expect(next.kind).toBe('dispatch'); expect((await restored.listTasks()).filter(t => t.state === 'completed')).toHaveLength(1);
  });
  it('queues when all sessions are busy and drains exactly one task when a slot is free', async () => {
    const f = await setup(1); const first = await dispatch(f);
    const busy = [{ ...f.executions[0], busy: true }];
    expect((await f.pool.handle({ ...f.input, messageId: 'second', text: 'unrelated', executions: busy })).kind).toBe('reply');
    expect(await f.pool.drain({ ...f.input, executions: busy })).toEqual([]);
    const results = await f.pool.drain({ ...f.input, executions: [{ ...f.executions[0], delivered: true, turnId: 'original', response: '[BOTMUX_TASK_RESULT] result' }] });
    expect(results).toHaveLength(1); expect(results[0].sessionId).toBe(first.sessionId);
    expect(await f.pool.drain(f.input)).toEqual([]);
  });
  it('turns datetime checklist followup into a project card, then keeps the same session and task for iteration', async () => {
    const f = await setup(); const first = await dispatch(f);
    const facts = f.executions.map(e => e.sessionId === first.sessionId ? { ...e, delivered: true, turnId: 'original', response: '[BOTMUX_TASK_RESULT] corrected' } : e);
    f.decide.mockResolvedValueOnce({ action: 'continue', targetTaskId: first.taskId, title: 'Python discussion', project: f.project, instruction: 'datetime checklist with examples', message: '- checklist', longTerm: true, projectName: 'Python syntax', isolated: true });
    expect((await f.pool.handle({ ...f.input, messageId: 'checklist', text: 'datetime checklist with examples', executions: facts })).kind).toBe('reply');
    let task = (await f.pool.listTasks()).find(t => t.id === first.taskId)!; expect(task.projectOffer?.title).toBe('Python syntax');
    const created = await f.pool.handle({ ...f.input, targetTaskId: task.id, expectedRevision: task.revision, messageId: 'create', text: 'Python syntax', projectAction: 'create', projectName: 'Python syntax', executions: facts });
    if (created.kind !== 'dispatch') throw new Error('missing project dispatch');
    expect(created.taskId).toBe(first.taskId); expect(created.sessionId).toBe(first.sessionId); expect(created.instruction).toContain('datetime checklist');
    await f.pool.finish(created.attemptId, created.sessionId, true);
    task = (await f.pool.listTasks()).find(t => t.id === first.taskId)!; expect(task.conversationProjectId).toBeTruthy();
    expect(await f.pool.reserveSlots(f.input.owner)).toHaveLength(1);
    f.decide.mockResolvedValueOnce({ action: 'continue', targetTaskId: first.taskId, title: '', project: '', instruction: 'More timedelta examples', message: '- examples' });
    const nextFacts = facts.map(e => e.sessionId === first.sessionId ? { ...e, turnId: 'create', response: '[BOTMUX_TASK_RESULT] checklist' } : e);
    const next = await f.pool.handle({ ...f.input, messageId: 'examples', text: 'More timedelta examples', executions: nextFacts });
    if (next.kind !== 'dispatch') throw new Error('missing iteration'); expect(next.sessionId).toBe(first.sessionId); expect(next.taskId).toBe(first.taskId);
    expect(next.instruction).toContain('More timedelta examples'); expect(next.instruction).toContain('datetime checklist');
    expect((await f.pool.listProjects(f.input.owner))).toHaveLength(1);
  });
  it('releases uncreated slot claims after definite prewarm failure and replaces only closed executors', async () => {
    const f = await setup();
    const root = mkdtempSync(join(tmpdir(), 'pool-claim-failure-')); const pool = new RouterSessionPool(root, { decide: f.decide });
    const reserved = await pool.reserveSlots(f.input.owner);
    for (const slot of reserved) await pool.releaseSlotCreation(slot.id, slot.owner);
    expect(await new RouterSessionPool(root, { decide: f.decide }).reserveSlots(f.input.owner)).toHaveLength(4);
    await f.pool.retireClosedSlots(f.input.owner, f.executions.map(e => ({ ...e, closed: true })));
    expect(await f.pool.reserveSlots(f.input.owner)).toHaveLength(4);
  });
  it('settles a precisely delivered dispatch after finish persistence was lost without resending', async () => {
    const f = await setup(1); const result = await f.pool.handle(f.input); if (result.kind !== 'dispatch') throw new Error('missing');
    const restored = new RouterSessionPool(f.root, { decide: f.decide });
    await restored.reconcile([{ ...f.executions[0], delivered: true, turnId: 'original', response: '[BOTMUX_TASK_RESULT] done' }]);
    expect((await restored.listTasks())[0].state).toBe('completed'); expect(await restored.drain(f.input)).toEqual([]);
  });
  it('invalidates old text approvals when a long project gets a different authorization proposal', async () => {
    const f = await setup(); const first = await dispatch(f);
    const facts = f.executions.map(e => e.sessionId === first.sessionId ? { ...e, delivered: true, turnId: 'original', response: '[BOTMUX_TASK_RESULT] done' } : e);
    const created = await f.pool.handle({ ...f.input, targetTaskId: first.taskId, projectAction: 'create', messageId: 'create', text: 'Python', executions: facts });
    if (created.kind !== 'dispatch') throw new Error('missing'); await f.pool.finish(created.attemptId, created.sessionId, true);
    const done = facts.map(e => e.sessionId === first.sessionId ? { ...e, turnId: 'create' } : e);
    f.decide.mockImplementation(async c => ({ action: 'continue', targetTaskId: first.taskId, title: '', project: '', instruction: c.message, message: '- authorization', requiresApproval: true }));
    await f.pool.handle({ ...f.input, messageId: 'danger-one', text: 'delete repository', executions: done });
    const old = (await f.pool.listTasks()).find(t => t.id === first.taskId)!;
    await f.pool.handle({ ...f.input, messageId: 'danger-two', text: 'different privileged operation', executions: done });
    const current = (await f.pool.listTasks()).find(t => t.id === first.taskId)!;
    expect(current.proposalRevision).not.toBe(old.proposalRevision);
    expect((await f.pool.handle({ ...f.input, messageId: 'old-approval', text: `approve task ${first.taskId} v${old.proposalRevision}`, executions: done })).kind).toBe('reply');
    const approved = await f.pool.handle({ ...f.input, messageId: 'new-approval', text: `approve task ${first.taskId} v${current.proposalRevision}`, executions: done });
    expect(approved.kind).toBe('dispatch');
  });
  it('validates configurable pool size without changing legacy router settings', async () => {
    const { normalizeAgentRouter } = await import('../src/bot-registry.js');
    expect(normalizeAgentRouter({ poolSize: 4 })).toMatchObject({ poolSize: 4 });
    for (const poolSize of [0, 17, 1.5, '4']) expect(() => normalizeAgentRouter({ poolSize })).toThrow();
    expect(normalizeAgentRouter(false)).toBe(false);
  });
  it('lets cancellation invalidate a still-analyzing task before it can dispatch', async () => {
    const f = await setup(); let release!: (d: RouterDecision) => void;
    f.decide.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const pending = f.pool.handle(f.input);
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    expect((await f.pool.handle({ ...f.input, messageId: 'cancel', text: '取消任务' })).kind).toBe('reply');
    release({ action: 'propose', title: 'A', project: f.project, instruction: 'A', message: '- A', isolated: true });
    expect((await pending).kind).toBe('reply'); expect((await f.pool.listTasks())[0].state).toBe('cancelled');
  });
  it('recognizes actual transcript delivery even when lastTurn is not yet delivered', () => {
    const facts = routerExecutionFacts({ session: { sessionId: 's', lastTurn: { turnId: 'old', outcome: 'interrupted' } }, worker: { killed: false },
      lastScreenStatus: 'idle', currentTurnId: 'current', completedIdleTurnId: 'current', lastScreenContent: '[BOTMUX_TASK_RESULT] done' } as any);
    expect(facts.delivered).toBe(true); expect(facts.turnId).toBe('current'); expect(facts.interrupted).toBe(false);
    const routed = routerExecutionFacts({ session: { sessionId: 's' }, worker: { killed: false }, currentTurnId: 'current',
      routerDeliveredOutput: { turnId: 'current', content: '[BOTMUX_TASK_RESULT] actual delivered output' }, lastScreenContent: 'old screen', lastScreenStatus: 'idle' } as any);
    expect(routed.delivered).toBe(true); expect(routed.response).toBe('[BOTMUX_TASK_RESULT] actual delivered output');
    const stale = routerExecutionFacts({ session: { sessionId: 's' }, currentTurnId: 'next', routerDeliveredOutput: { turnId: 'current', content: 'old result' } } as any);
    expect(stale.delivered).toBe(false);
  });
  it('retains unknown dispatch after restart and never claims the same slot twice', async () => {
    const f = await setup(1); const result = await f.pool.handle(f.input);
    if (result.kind !== 'dispatch') throw new Error('missing');
    const restored = new RouterSessionPool(f.root, { decide: f.decide });
    expect(await restored.drain(f.input)).toEqual([]);
    expect((await restored.handle({ ...f.input, messageId: 'second', text: 'new' })).kind).toBe('reply');
    expect((await restored.listTasks()).filter(t => t.state === 'dispatching')).toHaveLength(1);
  });
  it('imports legacy tasks for recent similarity and preserves their session when promoted', async () => {
    const f = await setup(); const root = mkdtempSync(join(tmpdir(), 'router-legacy-test-'));
    const old = { id: 'legacy', owner: f.input.owner, conversation: f.input.conversation, revision: 4, state: 'review', title: 'Python', project: f.project,
      instruction: 'correct code', isolated: true, history: [{ role: 'user', text: 'original code' }], seen: ['legacy'], attempt: { id: 'a', turnId: 'legacy', sessionId: 'legacy-session' } };
    writeFileSync(join(root, 'ledger.json'), JSON.stringify({ version: 1, tasks: [old] }));
    const pool = new RouterSessionPool(root, { decide: f.decide });
    expect((await pool.listTasks())[0].id).toBe('legacy');
    const result = await pool.handle({ ...f.input, messageId: 'promote', targetTaskId: 'legacy', projectAction: 'create', projectName: 'Python', text: 'Python',
      executions: [{ sessionId: 'legacy-session', busy: false, waiting: false, closed: false, interrupted: false, delivered: true, workingDir: f.project }] });
    if (result.kind !== 'dispatch') throw new Error('missing'); expect(result.taskId).toBe('legacy'); expect(result.sessionId).toBe('legacy-session');
  });
  it('does not steal an old pooled executor now running a different task during project creation', async () => {
    const f = await setup(1); const first = await dispatch(f);
    const done = [{ ...f.executions[0], delivered: true, turnId: 'original', response: '[BOTMUX_TASK_RESULT] done' }]; await f.pool.reconcile(done);
    const next = await f.pool.handle({ ...f.input, messageId: 'new', text: 'btw unrelated', executions: done }); if (next.kind !== 'dispatch') throw new Error('missing');
    const result = await f.pool.handle({ ...f.input, targetTaskId: first.taskId, messageId: 'create-old', text: 'old project', projectAction: 'create', projectName: 'old project', executions: done });
    expect(result.kind).toBe('reply'); expect(await f.pool.listProjects(f.input.owner)).toEqual([]);
  });
  it('preserves the runtime identity of a pooled session while its task changes', async () => {
    const { activeSessionKey } = await import('../src/core/types.js');
    const base: any = { larkAppId: 'app', chatId: 'chat', scope: 'chat', session: { sessionId: 's', chatId: 'chat', rootMessageId: 'root', routerPool: { slotId: 'slot', owner: 'app:owner' }, routerTask: { taskId: 'old' } } };
    const before = activeSessionKey(base); base.session.routerTask.taskId = 'new';
    expect(activeSessionKey(base)).toBe(before);
    const other = { ...base, session: { ...base.session, routerPool: { slotId: 'other', owner: 'app:owner' } } };
    expect(activeSessionKey(other)).not.toBe(before);
  });
  it('does not revive a closed project from queued work or a pending classifier', async () => {
    const f = await setup(); const first = await dispatch(f);
    const facts = f.executions.map(e => e.sessionId === first.sessionId ? { ...e, delivered: true, turnId: 'original', response: '[BOTMUX_TASK_RESULT] done' } : e);
    const created = await f.pool.handle({ ...f.input, targetTaskId: first.taskId, projectAction: 'create', messageId: 'create', text: 'Python', executions: facts });
    if (created.kind !== 'dispatch') throw new Error('missing'); await f.pool.finish(created.attemptId, created.sessionId, true);
    f.decide.mockResolvedValueOnce({ action: 'continue', targetTaskId: first.taskId, title: '', project: '', instruction: 'next', message: '- next' });
    await f.pool.handle({ ...f.input, messageId: 'queued', text: 'next', executions: facts.map(e => e.sessionId === first.sessionId ? { ...e, busy: true, delivered: false } : e) });
    const done = facts.map(e => e.sessionId === first.sessionId ? { ...e, turnId: 'create' } : e);
    await f.pool.reconcile(done);
    let release!: (d: RouterDecision) => void; f.decide.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const pending = f.pool.handle({ ...f.input, conversation: 'another', messageId: 'pending', text: 'more', executions: done });
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    await f.pool.handle({ ...f.input, targetTaskId: first.taskId, messageId: 'accept', text: '验收完成', executions: done });
    release({ action: 'continue', targetTaskId: first.taskId, title: '', project: '', instruction: 'more', message: '- more' });
    expect((await pending).kind).toBe('reply'); expect(await f.pool.drain({ ...f.input, executions: done })).toEqual([]);
    expect((await f.pool.listTasks()).find(t => t.id === first.taskId)?.state).toBe('completed');
    expect(await f.pool.listProjects(f.input.owner)).toEqual([]);
  });
  it('does not merge a similar project until user confirms and rejects another requester', async () => {
    const f = await setup(); const first = await dispatch(f); const facts = f.executions.map(e => e.sessionId === first.sessionId ? { ...e, delivered: true, turnId: 'original', response: '[BOTMUX_TASK_RESULT] done' } : e);
    const created = await f.pool.handle({ ...f.input, targetTaskId: first.taskId, projectAction: 'create', projectName: 'Python', messageId: 'create', text: 'Python', executions: facts });
    if (created.kind !== 'dispatch') throw new Error('missing'); await f.pool.finish(created.attemptId, created.sessionId, true);
    const [project] = await f.pool.listProjects(f.input.owner);
    f.decide.mockResolvedValueOnce({ action: 'propose', title: 'Dates', project: f.project, instruction: 'date examples', message: '- examples', requiresApproval: true, longTerm: true, similarProjectIds: [project.id], isolated: true });
    await f.pool.handle({ ...f.input, conversation: 'another', messageId: 'dates', text: 'date examples', executions: facts });
    const offer = (await f.pool.listTasks()).find(t => t.projectOffer?.candidates.includes(project.id))!; expect(offer.attempt).toBeUndefined();
    expect((await f.pool.handle({ ...f.input, conversation: 'another', owner: 'app:other', targetTaskId: offer.id, projectAction: 'merge', mergeProjectId: project.id, messageId: 'bad', text: 'merge' })).kind).toBe('reply');
    const merged = await f.pool.handle({ ...f.input, conversation: 'another', targetTaskId: offer.id, projectAction: 'merge', mergeProjectId: project.id, messageId: 'merge', text: 'merge', executions: facts.map(e => e.sessionId === created.sessionId ? { ...e, delivered: true, turnId: 'create', response: '[BOTMUX_TASK_RESULT] done' } : e) });
    expect(merged.kind).toBe('reply');
    const dest = (await f.pool.listTasks()).find(t => t.id === first.taskId)!; expect(dest.approvalRequired).toBe(true);
    const approved = await f.pool.handle({ ...f.input, messageId: 'approve', text: `批准执行 ${dest.id}`, executions: facts.map(e => e.sessionId === created.sessionId ? { ...e, turnId: 'create', delivered: true } : e) });
    if (approved.kind !== 'dispatch') throw new Error('missing approval'); expect(approved.taskId).toBe(first.taskId); expect(approved.sessionId).toBe(first.sessionId);
  });
});
