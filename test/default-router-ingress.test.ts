import { describe, it, expect, vi } from 'vitest';
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ts from 'typescript';
import { DefaultRouter, canonicalRouterProjects, routerConversation, routerExecutionFacts } from '../src/services/default-router.js';
import { resolvePiModel } from '../src/adapters/cli/pi-model.js';
import { routerProgressCard, interruptRouterProgress } from '../src/services/router-progress.js';
import { buildNewTopicCliInput } from '../src/core/session-manager.js';

// Non-text assertion: execute the production daemon function with fake external
// boundaries. The daemon module itself starts services and cannot be imported.
const source = ts.createSourceFile('daemon.ts', readFileSync(join(process.cwd(), 'src/daemon.ts'), 'utf8'), ts.ScriptTarget.Latest, true);
function load(name: string, scope: Record<string, any>) {
  const declaration = source.statements.find(s => ts.isFunctionDeclaration(s) && s.name?.text === name);
  if (!declaration) throw new Error(`missing ${name}`);
  const code = ts.transpileModule(declaration.getText(source), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const proxy = new Proxy(scope, { has: (_, key) => key !== Symbol.unscopables,
    get: (object, key) => key in object ? object[key as string] : (globalThis as any)[key] });
  return new Function('scope', `with(scope){${code}; return ${name};}`)(proxy);
}
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'router-ingress-'));
  const handle = vi.fn(async () => ({ kind: 'reply', text: 'clarify' }));
  const ds: any = { workingDir: root, session: { ownerOpenId: 'owner', sessionId: 's', status: 'active' }, worker: { killed: false }, workerReady: true, lastScreenStatus: 'idle', larkAppId: 'app' };
  const scope = { getBot: () => ({ config: { workingDir: root, cliId: 'pi' } }), activeSessions: new Map([['anchor', ds]]),
    sessionKey: (anchor: string) => anchor, config: { session: { dataDir: root } },
    routerProgressCard, interruptRouterProgress, DefaultRouter, canonicalRouterProjects, routerConversation, routerExecutionFacts, resolvePiModel, join,
    defaultRouters: new Map([['app:owner', { signature: JSON.stringify(['pi', undefined, undefined]), router: { handle } }]]) };
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
  it('delivers approved instruction in Codex clean input, not the approval keyword', () => {
    const instruction = 'Implement the confirmed task with tests';
    const built = buildNewTopicCliInput(instruction, 's', 'codex-app', undefined, undefined, undefined,
      undefined, undefined, undefined, 'zh', undefined, { promptInjection: 'none', codexAppText: instruction, codexAppMessageContext: '' });
    expect(built.codexAppInput?.text).toBe(instruction);
  });
});
