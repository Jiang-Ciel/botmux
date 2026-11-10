import { describe, it, expect, vi } from 'vitest';
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ts from 'typescript';
import { DefaultRouter, canonicalRouterProjects, routerConversation, routerExecutionFacts } from '../src/services/default-router.js';
import { resolvePiModel } from '../src/adapters/cli/pi-model.js';
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
  const ds: any = { workingDir: root, session: { ownerOpenId: 'owner', sessionId: 's', status: 'active' }, worker: { killed: false }, workerReady: true, lastScreenStatus: 'idle' };
  const scope = { getBot: () => ({ config: { workingDir: root } }), activeSessions: new Map([['anchor', ds]]),
    sessionKey: (anchor: string) => anchor, config: { session: { dataDir: root } },
    DefaultRouter, canonicalRouterProjects, routerConversation, routerExecutionFacts, resolvePiModel, join,
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
    expect(input.controlText).toBe('批准执行'); expect(input.execution.busy).toBe(false);
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
  it('delivers approved instruction in Codex clean input, not the approval keyword', () => {
    const instruction = 'Implement the confirmed task with tests';
    const built = buildNewTopicCliInput(instruction, 's', 'codex-app', undefined, undefined, undefined,
      undefined, undefined, undefined, 'zh', undefined, { promptInjection: 'none', codexAppText: instruction, codexAppMessageContext: '' });
    expect(built.codexAppInput?.text).toBe(instruction);
  });
});
