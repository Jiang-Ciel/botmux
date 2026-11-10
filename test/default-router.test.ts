import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DefaultRouter, type RouterInput, type RouterDecision, routerConversation, routerExecutionFacts } from '../src/services/default-router.js';
import { parseEventMessage, stripLeadingMentions } from '../src/im/lark/message-parser.js';
import type { DaemonSession } from '../src/core/types.js';
import { normalizeAgentRouter } from '../src/bot-registry.js';

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'default-router-test-'));
  const project = join(root, 'project'); mkdirSync(project);
  const decide = vi.fn(async (): Promise<RouterDecision> => ({ action: 'propose', message: 'ready', title: 'task', project, instruction: 'implement with tests' }));
  const router = new DefaultRouter(join(root, 'ledger'), { decide });
  const input: RouterInput = { conversation: 'c', owner: 'owner', messageId: 'm1', text: 'build it', projects: [project] };
  return { root, project, decide, router, input };
}
describe('default hidden router', () => {
  it('requires explicit approval, persists the dispatch fence and never replays unknown submissions', async () => {
    const { root, router, input, decide } = setup();
    expect((await router.handle(input)).kind).toBe('reply');
    const result = await router.handle({ ...input, messageId: 'm2', text: '批准执行' });
    expect(result.kind).toBe('dispatch');
    const restored = new DefaultRouter(join(root, 'ledger'), { decide });
    expect((await restored.handle({ ...input, messageId: 'm3', text: '批准执行' })).kind).toBe('reply');
    expect(decide).toHaveBeenCalledTimes(1);
  });
  it('uses host-stripped mention text for explicit controls', async () => {
    const { router, input, decide } = setup();
    await router.handle(input);
    const { parsed } = parseEventMessage({ sender: { sender_type: 'user', sender_id: { open_id: 'ou_owner' } },
      message: { message_type: 'text', content: JSON.stringify({ text: '@_user_1 批准执行' }),
        mentions: [{ key: '@_user_1', name: 'Bot', id: { open_id: 'ou_bot' } }], chat_type: 'group', message_id: 'approve', chat_id: 'chat' } });
    const result = await router.handle({ ...input, messageId: 'approve', text: parsed.content,
      controlText: stripLeadingMentions(parsed.content, parsed.mentions) });
    expect(result.kind).toBe('dispatch'); expect(decide).toHaveBeenCalledTimes(1);
  });
  it('projects lifecycle-active idle sessions as idle so acceptance releases the fence', async () => {
    const { root, router, input } = setup(); await router.handle(input);
    const result = await router.handle({ ...input, messageId: 'approve', text: '批准执行' });
    if (result.kind !== 'dispatch') throw new Error('missing dispatch');
    await router.finish(result.attemptId, 'session', true);
    const ds = { session: { sessionId: 'session', status: 'active', lastTurn: { outcome: 'delivered', turnId: 'approve', at: Date.now() } },
      worker: { killed: false }, workerReady: true, lastScreenStatus: 'idle' } as unknown as DaemonSession;
    const execution = routerExecutionFacts(ds);
    expect(execution.busy).toBe(false);
    await router.handle({ ...input, messageId: 'accept', text: '验收完成', execution });
    expect(JSON.parse(readFileSync(join(root, 'ledger', 'ledger.json'), 'utf8')).tasks[0].state).toBe('completed');
  });
  it('invalidates approval if a requirement edit fails inference', async () => {
    const { router, input, decide } = setup();
    await router.handle(input);
    decide.mockRejectedValueOnce(new Error('offline'));
    await router.handle({ ...input, messageId: 'edit', text: 'change scope' });
    const result = await router.handle({ ...input, messageId: 'approve', text: '批准执行' });
    expect(result.kind).toBe('reply');
    expect(decide).toHaveBeenCalledTimes(3);
  });
  it('blocks a second task in the same project across ledger instances', async () => {
    const { root, router, input, decide } = setup();
    await router.handle(input);
    await router.handle({ ...input, messageId: 'a', text: '批准执行' });
    const second = new DefaultRouter(join(root, 'ledger'), { decide });
    const other = { ...input, conversation: 'other', owner: 'other' };
    await second.handle(other);
    expect((await second.handle({ ...other, messageId: 'b', text: '批准执行' })).kind).toBe('reply');
  });
  it('rejects arbitrary projects from a model', async () => {
    const { router, input, decide } = setup();
    decide.mockResolvedValueOnce({ action: 'propose', message: 'ready', title: 'task', project: '/unauthorized', instruction: 'write' });
    await router.handle(input);
    expect((await router.handle({ ...input, messageId: 'a', text: '批准执行' })).kind).toBe('reply');
  });
  it('does not release running or interrupted fences on cancellation or missing sessions', async () => {
    const { router, input } = setup();
    await router.handle(input);
    const result = await router.handle({ ...input, messageId: 'a', text: '批准执行' });
    if (result.kind !== 'dispatch') throw new Error('missing dispatch');
    await router.finish(result.attemptId, 'session', true);
    expect((await router.handle({ ...input, messageId: 'cancel', text: '取消任务' })).kind).toBe('reply');
    expect((await router.handle({ ...input, messageId: 'retry', text: '批准执行' })).kind).toBe('reply');
  });
  it('only accepts the matching delivered turn after human acceptance', async () => {
    const { root, router, input } = setup();
    await router.handle(input);
    const result = await router.handle({ ...input, messageId: 'a', text: '批准执行' });
    if (result.kind !== 'dispatch') throw new Error('missing dispatch');
    await router.finish(result.attemptId, 'session', true);
    const execution = { sessionId: 'session', busy: false, waiting: false, closed: false, interrupted: false, delivered: true, turnId: 'old' };
    await router.handle({ ...input, messageId: 'check', text: '验收完成', execution });
    const ledger = () => JSON.parse(readFileSync(join(root, 'ledger', 'ledger.json'), 'utf8'));
    expect(ledger().tasks[0].state).toBe('running');
    await router.handle({ ...input, messageId: 'accept', text: '验收完成', execution: { ...execution, turnId: 'a' } });
    expect(ledger().tasks[0].state).toBe('completed');
  });
  it('serializes overlapping clarification and cancel; cancellation stays final', async () => {
    const { root, router, input, decide } = setup();
    let release!: (d: RouterDecision) => void;
    decide.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const first = router.handle(input);
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    const cancel = router.handle({ ...input, messageId: 'cancel', text: '取消任务' });
    release({ action: 'propose', message: 'ready', title: 't', project: input.projects[0], instruction: 'work' });
    await Promise.all([first, cancel]);
    expect(JSON.parse(readFileSync(join(root, 'ledger', 'ledger.json'), 'utf8')).tasks[0].state).toBe('cancelled');
  });
  it('does not release review fences when cancellation overlaps renewed execution', async () => {
    const { root, router, input } = setup(); await router.handle(input);
    const d = await router.handle({ ...input, messageId: 'approve', text: '批准执行' });
    if (d.kind !== 'dispatch') throw new Error('missing dispatch');
    await router.finish(d.attemptId, 's', true);
    const execution = { sessionId: 's', busy: false, waiting: false, closed: false, interrupted: false, delivered: true, turnId: 'approve' };
    await router.handle({ ...input, messageId: 'check', text: 'check', execution });
    await router.handle({ ...input, messageId: 'cancel', text: '取消任务', execution: { ...execution, busy: true } });
    expect(JSON.parse(readFileSync(join(root, 'ledger', 'ledger.json'), 'utf8')).tasks[0].state).toBe('review');
    const other = { ...input, conversation: 'other', owner: 'other', messageId: 'other' }; await router.handle(other);
    expect((await router.handle({ ...other, messageId: 'other-approve', text: '批准执行' })).kind).toBe('reply');
  });
  it('rejects stale analysis after another ledger instance observes missing execution', async () => {
    const { root, router, input, decide } = setup(); await router.handle(input);
    const dispatched = await router.handle({ ...input, messageId: 'approve', text: '批准执行' });
    if (dispatched.kind !== 'dispatch') throw new Error('missing dispatch');
    await router.finish(dispatched.attemptId, 's', true);
    let release!: (decision: RouterDecision) => void;
    decide.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const edit = router.handle({ ...input, messageId: 'edit', text: 'change scope', execution: {
      sessionId: 's', busy: false, waiting: false, closed: false, interrupted: false, delivered: false } });
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    const other = new DefaultRouter(join(root, 'ledger'), { decide });
    await other.handle({ ...input, messageId: 'missing' });
    release({ action: 'propose', title: 'changed', message: 'changed', project: input.projects[0], instruction: 'new scope' });
    expect((await edit).kind).toBe('reply');
    const stored = JSON.parse(readFileSync(join(root, 'ledger', 'ledger.json'), 'utf8')).tasks[0];
    expect(stored.state).toBe('blocked');
    expect(stored.history.some((item: { text: string }) => item.text === 'changed')).toBe(false);
    expect((await other.handle({ ...input, messageId: 'reapprove', text: '批准执行' })).kind).toBe('reply');
  });
  it('never treats model continue as permission to inject more execution', async () => {
    const { router, input, decide } = setup(); await router.handle(input);
    const dispatched = await router.handle({ ...input, messageId: 'approve', text: '批准执行' });
    if (dispatched.kind !== 'dispatch') throw new Error('missing dispatch');
    await router.finish(dispatched.attemptId, 's', true);
    decide.mockResolvedValueOnce({ action: 'continue', title: 't', message: 'continue', project: input.projects[0], instruction: 'delete everything' });
    expect((await router.handle({ ...input, messageId: 'edit', text: 'new scope', execution: {
      sessionId: 's', busy: false, waiting: false, closed: false, interrupted: false, delivered: false } })).kind).toBe('reply');
  });
  it('deduplicates completed analysis and fails closed on corrupt storage', async () => {
    const { root, router, input, decide } = setup();
    await router.handle(input); await router.handle(input);
    expect(decide).toHaveBeenCalledTimes(1);
    writeFileSync(join(root, 'ledger', 'ledger.json'), '{');
    await expect(router.handle({ ...input, messageId: 'next' })).rejects.toThrow();
  });
  it('isolates conversations by bot, requester and anchor and validates configuration', () => {
    expect(routerConversation('a', 'chat', 'thread', 'anchor', 'owner')).not.toBe(routerConversation('a', 'chat', 'thread', 'anchor', 'other'));
    expect(normalizeAgentRouter(undefined)).toBeUndefined();
    expect(normalizeAgentRouter(false)).toBe(false);
    expect(() => normalizeAgentRouter({ enabled: true })).toThrow();
  });
});
