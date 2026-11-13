import { routerTaskSummaryCard } from '../src/im/lark/router-task-card.js';
import { describe, it, expect, vi } from 'vitest';
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ts from 'typescript';
import { DefaultRouter, canonicalRouterProjects, routerConversation, routerExecutionFacts } from '../src/services/default-router.js';
import { resolvePiModel } from '../src/adapters/cli/pi-model.js';
import { routerProgressCard, interruptRouterProgress } from '../src/services/router-progress.js';
import { beginReplyTargetTurn } from '../src/core/reply-target.js';
import { buildNewTopicCliInput, buildFollowUpCliInput } from '../src/core/session-manager.js';

// Non-text assertion: execute the production daemon function with fake external
// boundaries. The daemon module itself starts services and cannot be imported.
const source = ts.createSourceFile('daemon.ts', readFileSync(join(process.cwd(), 'src/daemon.ts'), 'utf8'), ts.ScriptTarget.Latest, true);
function load(name: string, scope: Record<string, any>) {
  const declaration = source.statements.find(s => ts.isFunctionDeclaration(s) && s.name?.text === name);
  if (!declaration) throw new Error(`missing ${name}`);
  const code = ts.transpileModule(declaration.getText(source), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  if (scope.sessionStore && !scope.sessionStore.updateRouterTask) scope.sessionStore.updateRouterTask = (session: any, _expected: any, next: any) => { session.routerTask = next; };
  const proxy = new Proxy(scope, { has: (_, key) => key !== Symbol.unscopables,
    get: (object, key) => { if (key === 'sessionStore' && object.sessionStore && !object.sessionStore.updateRouterTask) object.sessionStore.updateRouterTask = (session: any, _expected: any, next: any) => { session.routerTask = next; }; return key in object ? object[key as string] : (globalThis as any)[key]; } });
  return new Function('scope', `with(scope){${code}; return ${name};}`)(proxy);
}
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'router-ingress-'));
  const handle = vi.fn(async () => ({ kind: 'reply', text: 'clarify' }));
  const ds: any = { workingDir: root, session: { ownerOpenId: 'owner', sessionId: 's', status: 'active' }, worker: { killed: false }, workerReady: true, lastScreenStatus: 'idle', larkAppId: 'app' };
  const scope = { getBot: () => ({ config: { workingDir: root, cliId: 'pi' } }), activeSessions: new Map([['anchor', ds]]),
    sessionKey: (anchor: string) => anchor, config: { session: { dataDir: root } },
    routerBoards: { ensure: vi.fn(async () => {}), offerProject: vi.fn(async () => {}) },
    ensureRouterPool: vi.fn(async () => {}), routerPoolRoutes: new Map(),
    routerTaskSummaryCard, routerProgressCard, interruptRouterProgress, DefaultRouter, canonicalRouterProjects, routerConversation, routerExecutionFacts, resolvePiModel, join,
    defaultRouters: new Map([['app:owner', { signature: JSON.stringify(['pi', undefined, undefined]), router: { handle, listTasks: async () => [] } }]]) };
  Object.assign(scope, { dispatchOrdinaryRouterTask: load('dispatchOrdinaryRouterTask', scope) });
  const route = load('routeOrdinaryHuman', scope);
  const input = { ctx: { larkAppId: 'app', chatId: 'chat', scope: 'thread', anchor: 'anchor', messageId: 'm' },
    data: { sender: { sender_type: 'user', sender_id: { open_id: 'owner' } } }, text: '@Bot 批准执行', command: '批准执行', resources: [] };
  return { route, input, ds, handle, scope };
}
describe('default router ordinary ingress', () => {
  it('preserves the host control lane and uses runtime-idle facts', async () => {
    const f = setup(); await f.route(f.input);
    const input = f.handle.mock.calls[0][0] as any;
    expect(input.controlText).toBe('批准执行'); expect(input.executions[0].busy).toBe(false);
    const other = { ...f.ds, session: { ...f.ds.session, sessionId: 'other' } };
    f.scope.activeSessions.set('other', other);
    const project = canonicalRouterProjects([f.ds.workingDir])[0];
    expect(input.projectBusy(project)).toBe(false);
    other.lastScreenStatus = 'working'; expect(input.projectBusy(project)).toBe(true);
  });
  it('keeps explicit commands, adopted sessions, waiting answers and attention snapshots outside semantic routing', async () => {
    const f = setup();
    expect(await f.route({ ...f.input, command: '/session' })).toBeUndefined();
    f.ds.adoptedFrom = {}; expect(await f.route(f.input)).toBeUndefined(); delete f.ds.adoptedFrom;
    f.ds.agentAttention = { kind: 'decision' }; expect(await f.route(f.input)).toBeUndefined();
    delete f.ds.agentAttention;
    expect(await f.route({ ...f.input, skip: true })).toBeUndefined();
    expect(f.handle).not.toHaveBeenCalled();
  });
  it('dispatches to an independently registered task executor without reusing the visible anchor owner', async () => {
    const f = setup();
    const finish = vi.fn(async () => {}); const bind = vi.fn(async () => {});
    f.handle.mockResolvedValueOnce({ kind: 'dispatch', instruction: 'approved work', project: f.ds.workingDir,
      attemptId: 'attempt', taskId: 'task', title: '南京天气', sourceMessageId: 'original' } as any);
    f.scope.defaultRouters.get('app:owner').router.finish = finish;
    f.scope.defaultRouters.get('app:owner').router.bind = bind;
    const createSession = vi.fn(() => ({ sessionId: 'independent', status: 'active' }));
    const register = vi.fn(async () => ({ accepted: true }));
    const fork = vi.fn((_ds, _payload, _turn, options) => { options.onAdmission('accepted'); return true; });
    Object.assign(f.scope, {
      evaluatePromptGate: async () => ({ allowed: true }), sessionStore: { createSession, updateSession: vi.fn() },
      stampHumanActivity: vi.fn(), beginReplyTargetTurn: vi.fn(), claimNewDaemonSession: register,
      trustedCallerForInboundTurn: async () => undefined, getAvailableBots: async () => [], localeForBot: () => 'zh',
      buildNewTopicCliInput, forkWorker: fork, markIngressAdmitted: vi.fn(), logger: { warn: vi.fn(), error: vi.fn() },
    });
    const result = await f.route(f.input);
    expect(result.kind).toBe('reply'); expect(result.text).toContain('independent');
    const executor = register.mock.calls[0][1]; expect(executor.session.routerTask.taskId).toBe('task');
    expect(executor.session.routerTask.sourceMessageId).toBe('original'); expect(executor).not.toBe(f.ds);
    expect(f.scope.activeSessions.get('anchor')).toBe(f.ds);
    expect(bind).toHaveBeenCalledWith('attempt', 'independent'); expect(finish).toHaveBeenCalledWith('attempt', 'independent', true);
  });
  it.each(['pi', 'codex-app', 'claude'])('continues the exact existing task session using %s without creating or forking a replacement', async cliId => {
    const f = setup();
    const bind = vi.fn(async () => {}); const finish = vi.fn(async () => {});
    f.scope.defaultRouters.get('app:owner').router.bind = bind;
    f.scope.defaultRouters.get('app:owner').router.finish = finish;
    const executor: any = { ...f.ds, session: { ...f.ds.session, sessionId: 'original-session', routerTask: { taskId: 'task', attemptId: 'old' } } };
    f.scope.activeSessions.set('executor', executor);
    f.handle.mockResolvedValueOnce({ kind: 'dispatch', instruction: 'full supplemental code', project: f.ds.workingDir,
      attemptId: 'continue-attempt', taskId: 'task', title: 'format', sessionId: 'original-session' } as any);
    const createSession = vi.fn(); const fork = vi.fn(); const send = vi.fn(() => true);
    Object.assign(f.scope, {
      getBot: () => ({ config: { workingDir: f.ds.workingDir, cliId } }),
      evaluatePromptGate: async () => ({ allowed: true }), sessionStore: { createSession, updateSession: vi.fn() },
      trustedCallerForInboundTurn: async () => undefined, buildFollowUpCliInput,
      beginReplyTargetTurn: vi.fn(), sendWorkerInput: send, forkWorker: fork, sessionPromptInjection: () => 'none',
      markIngressAdmitted: vi.fn(), beginNewTurn: vi.fn(), rememberLastCliInput: vi.fn(), markSessionActivity: vi.fn(),
    });
    const result = await f.route(f.input);
    expect(result.text).toContain('original-session'); expect(createSession).not.toHaveBeenCalled(); expect(fork).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledTimes(1); expect(send.mock.calls[0][0]).toBe(executor);
    expect(bind).toHaveBeenCalledWith('continue-attempt', 'original-session');
    expect(finish).toHaveBeenCalledWith('continue-attempt', 'original-session', true);
    expect(send.mock.calls[0][1]).toBe('full supplemental code');
  });
  it.each(['interrupted', 'closed', 'attention', 'owner', 'directory', 'removed', 'rejected'])('does not inject or replace a session after a mid-dispatch %s intervention', async intervention => {
    const f = setup(); const executor: any = { ...f.ds, session: { ...f.ds.session, sessionId: 'original-session', routerTask: { taskId: 'task', attemptId: 'old' } } };
    f.scope.activeSessions.set('executor', executor);
    const rejectContinuation = vi.fn(async () => {}); const finish = vi.fn(async () => {});
    const bind = vi.fn(async () => {
      if (intervention === 'interrupted') executor.session.lastTurn = { outcome: 'interrupted' };
      if (intervention === 'closed') executor.session.status = 'closed';
      if (intervention === 'attention') executor.agentAttention = { kind: 'decision' };
      if (intervention === 'owner') executor.session.ownerOpenId = 'other';
      if (intervention === 'directory') executor.workingDir = '/different';
      if (intervention === 'removed') f.scope.activeSessions.delete('executor');
    });
    Object.assign(f.scope.defaultRouters.get('app:owner').router, { bind, finish, rejectContinuation });
    f.handle.mockResolvedValueOnce({ kind: 'dispatch', instruction: 'supplement', project: f.ds.workingDir,
      attemptId: 'next', taskId: 'task', title: 'format', sessionId: 'original-session' } as any);
    const send = vi.fn(() => false); const createSession = vi.fn(); const fork = vi.fn();
    executor.currentReplyTarget = { turnId: 'original' }; executor.session.currentReplyTarget = executor.currentReplyTarget;
    Object.assign(f.scope, {
      evaluatePromptGate: async () => ({ allowed: true }), sessionStore: { createSession, updateSession: vi.fn() },
      trustedCallerForInboundTurn: async () => undefined, buildFollowUpCliInput, sessionPromptInjection: () => 'none',
      beginReplyTargetTurn: vi.fn(() => { executor.currentReplyTarget = { turnId: 'new' }; executor.session.currentReplyTarget = executor.currentReplyTarget; }),
      sendWorkerInput: send, forkWorker: fork,
    });
    await f.route(f.input);
    expect(createSession).not.toHaveBeenCalled(); expect(fork).not.toHaveBeenCalled(); expect(finish).not.toHaveBeenCalled();
    expect(rejectContinuation).toHaveBeenCalledWith('next');
    expect(send).toHaveBeenCalledTimes(intervention === 'rejected' ? 1 : 0);
    expect(executor.currentReplyTarget.turnId).toBe('original'); expect(executor.session.currentReplyTarget.turnId).toBe('original');
  });
  it('prewarms four registered empty sessions and keeps their pool identities independent', async () => {
    const f = setup(); let sequence = 0;
    const slots = Array.from({ length: 4 }, (_, i) => ({ id: `slot-${i}`, owner: 'app:owner', recentTaskIds: [] }));
    const bindSlot = vi.fn(async () => {}); const fork = vi.fn(); const register = vi.fn(async (_sessions, ds) => { f.scope.activeSessions.set(ds.session.sessionId, ds); return { accepted: true }; });
    Object.assign(f.scope, {
      sessionStore: { createSession: vi.fn(() => ({ sessionId: `pool-${sequence++}`, status: 'active' })), updateSession: vi.fn() },
      claimNewDaemonSession: register, forkReservedIdleSession: fork,
    });
    const warm = load('ensureRouterPool', f.scope);
    const router = { retireClosedSlots: vi.fn(async () => {}), releaseSlotCreation: vi.fn(async () => {}), reserveSlots: vi.fn(async () => slots), listSlots: vi.fn(async () => []), bindSlot, slotDirectory: (_owner: string, id: string) => `${f.ds.workingDir}/${id}` };
    await warm(router, f.input.ctx, f.input.data, 4);
    expect(register).toHaveBeenCalledTimes(4); expect(fork).toHaveBeenCalledTimes(4); expect(bindSlot).toHaveBeenCalledTimes(4);
    expect(register.mock.calls.map(call => call[1].session.routerPool.slotId)).toEqual(slots.map(slot => slot.id));
    expect(register.mock.calls.every(call => call[1].session.routerTask === undefined)).toBe(true);
  });
  it('a new one-shot task executes in a reused pool session without creating a replacement', async () => {
    const f = setup(); const executor: any = { ...f.ds, session: { ...f.ds.session, sessionId: 'pooled', routerPool: { slotId: 'slot', owner: 'app:owner' }, routerTask: { taskId: 'previous' } } };
    f.scope.activeSessions.set('executor', executor);
    f.handle.mockResolvedValueOnce({ kind: 'dispatch', instruction: 'unrelated one-shot', project: f.ds.workingDir, attemptId: 'next', taskId: 'new', sessionId: 'pooled', title: 'new' } as any);
    const createSession = vi.fn(); const send = vi.fn(() => true);
    Object.assign(f.scope.defaultRouters.get('app:owner').router, { bind: vi.fn(async () => {}), finish: vi.fn(async () => {}) });
    Object.assign(f.scope, { evaluatePromptGate: async () => ({ allowed: true }), sessionStore: { createSession, updateSession: vi.fn() },
      trustedCallerForInboundTurn: async () => undefined, buildFollowUpCliInput, sessionPromptInjection: () => 'none', beginReplyTargetTurn: vi.fn(), sendWorkerInput: send,
      markIngressAdmitted: vi.fn(), beginNewTurn: vi.fn(), rememberLastCliInput: vi.fn(), markSessionActivity: vi.fn() });
    await f.route(f.input); expect(send).toHaveBeenCalledTimes(1); expect(createSession).not.toHaveBeenCalled(); expect(executor.session.routerTask.taskId).toBe('new');
  });
  it('compensates a cold fork that returns true but later rejects admission', async () => {
    const f = setup(); const previous = { taskId: 'old', attemptId: 'old-a', sourceMessageId: 'old-m', title: 'old' };
    const executor: any = { ...f.ds, worker: null, session: { ...f.ds.session, sessionId: 'pool', routerPool: { slotId: 'slot', owner: 'app:owner' }, routerTask: previous } };
    f.scope.activeSessions.set('pool', executor);
    const reject = vi.fn(async () => {}); const finish = vi.fn(async () => {}); let admission!: (value: string) => void;
    Object.assign(f.scope.defaultRouters.get('app:owner').router, { bind: vi.fn(async () => {}), finish, rejectContinuation: reject });
    f.handle.mockResolvedValueOnce({ kind: 'dispatch', sessionId: 'pool', taskId: 'new', attemptId: 'next', project: f.ds.workingDir, instruction: 'next', title: 'new' } as any);
    Object.assign(f.scope, { evaluatePromptGate: async () => ({ allowed: true }), trustedCallerForInboundTurn: async () => undefined,
      sessionStore: { updateSession: vi.fn() }, buildFollowUpCliInput, sessionPromptInjection: () => 'none', beginReplyTargetTurn: vi.fn(),
      forkWorker: vi.fn((_ds, _payload, _turn, options) => { admission = options.onAdmission; return true; }),
      markIngressAdmitted: vi.fn(), beginNewTurn: vi.fn(), rememberLastCliInput: vi.fn(), markSessionActivity: vi.fn(), logger: { error: vi.fn() } });
    await f.route(f.input); expect(finish).not.toHaveBeenCalled();
    admission('rejected'); await vi.waitFor(() => expect(reject).toHaveBeenCalledWith('next'));
    expect(executor.session.routerTask).toEqual(previous); expect(finish).not.toHaveBeenCalled();
  });
  it('releases every unattempted pool slot after definite first registration rejection', async () => {
    const f = setup(); const release = vi.fn(async () => {});
    const slots = Array.from({ length: 4 }, (_, i) => ({ id: `slot-${i}`, owner: 'app:owner' }));
    Object.assign(f.scope, { sessionStore: { createSession: () => ({ sessionId: 's' }), updateSession: vi.fn() },
      claimNewDaemonSession: async () => ({ accepted: false }) });
    const router = { retireClosedSlots: vi.fn(async () => {}), reserveSlots: async () => slots,
      releaseSlotCreation: release, slotDirectory: () => f.ds.workingDir };
    await expect(load('ensureRouterPool', f.scope)(router, f.input.ctx, f.input.data, 4)).rejects.toThrow('router_pool_registration_failed');
    expect(release).toHaveBeenCalledTimes(4); expect(release.mock.calls.map(call => call[0])).toEqual(slots.map(slot => slot.id));
  });
  it.each([
    { scope: 'thread', chatId: 'oc_first', anchor: 'om_later_topic', target: { mode: 'thread', rootMessageId: 'om_later_topic' } },
    { scope: 'thread', chatId: 'oc_other_group', anchor: 'om_other_topic', target: { mode: 'thread', rootMessageId: 'om_other_topic' } },
    { scope: 'chat', chatId: 'oc_other_group', anchor: 'oc_other_group', target: { mode: 'plain', chatId: 'oc_other_group' } },
  ])('freezes this task origin, not the pooled first topic: %o', async origin => {
    const f = setup(); const executor: any = { ...f.ds, scope: 'thread', chatId: 'oc_first', session: { ...f.ds.session, rootMessageId: 'om_first_topic', chatId: 'oc_first', sessionId: 'pooled', routerPool: { slotId: 'slot', owner: 'app:owner' } } };
    f.scope.activeSessions.set('pooled', executor);
    f.handle.mockResolvedValueOnce({ kind: 'dispatch', instruction: 'next', project: f.ds.workingDir, sessionId: 'pooled', taskId: 'new', attemptId: 'next' } as any);
    Object.assign(f.scope.defaultRouters.get('app:owner').router, { bind: vi.fn(async () => {}), finish: vi.fn(async () => {}) });
    Object.assign(f.scope, { evaluatePromptGate: async () => ({ allowed: true }), trustedCallerForInboundTurn: async () => undefined,
      sessionStore: { updateSession: vi.fn() }, resolvePinnedWorkingDir: async () => ({ pinnedWorkingDir: f.ds.workingDir }), buildFollowUpCliInput, sessionPromptInjection: () => 'none', beginReplyTargetTurn,
      sendWorkerInput: () => true, markIngressAdmitted: vi.fn(), beginNewTurn: vi.fn(), rememberLastCliInput: vi.fn(), markSessionActivity: vi.fn() });
    await f.route({ ...f.input, ctx: { ...f.input.ctx, ...origin, messageId: 'om_new_message' } });
    expect(executor.session.turnReplyContexts.om_new_message.target).toEqual(origin.target);
    expect(executor.session.turnReplyContexts.om_new_message.sourceMessageId).toBeUndefined();
    expect(executor.session.turnReplyContexts.om_new_message.quoteTargetId).toBe('om_new_message');
    expect(executor.session.rootMessageId).toBe('om_first_topic');
  });
  it('returns a concise task-summary card instead of displaying the full execution instruction', async () => {
    const f = setup(); const title = '修正 Python 代码'; const instruction = '拒绝 不可用 未接纳 long normalized requirements '.repeat(100);
    f.handle.mockResolvedValueOnce({ kind: 'dispatch', title, instruction, project: f.ds.workingDir, taskId: 'task', attemptId: 'a' } as any);
    f.scope.dispatchOrdinaryRouterTask = async (_task: any, _router: any, _ctx: any, _data: any, onStatus: any) => { onStatus('执行请求已接纳'); return instruction; };
    f.scope.defaultRouters.get('app:owner').router.listTasks = async () => [{ id: 'task', coreWork: '修正导入和当前时间获取，完整输出代码。' }];
    const result = await f.route(f.input); expect(result.card.header.title.content).toBe(title);
    expect(result.card.body.elements[0].content).toContain('修正导入');
    expect(JSON.stringify(result.card)).not.toContain(instruction); expect(result.card.body.elements[1].content).toBe('执行请求已接纳');
  });
  it('delivers approved instruction in Codex clean input, not the approval keyword', () => {
    const instruction = 'Implement the confirmed task with tests';
    const built = buildNewTopicCliInput(instruction, 's', 'codex-app', undefined, undefined, undefined,
      undefined, undefined, undefined, 'zh', undefined, { promptInjection: 'none', codexAppText: instruction, codexAppMessageContext: '' });
    expect(built.codexAppInput?.text).toBe(instruction);
  });
});
