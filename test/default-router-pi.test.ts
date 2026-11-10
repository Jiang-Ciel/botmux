import { describe, it, expect, vi, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const fixture = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('../src/services/constrained-invocation/native-process.js', () => ({ spawnOwnedModelProcess: fixture.spawn }));
import { PiRouterProvider } from '../src/services/default-router-pi.js';
import type { RouterContext } from '../src/services/default-router.js';
const answer = { action: 'clarify', message: 'which project?', title: 'task', project: '', instruction: '' };
function setup() {
  const stdout = new PassThrough(); const child = new EventEmitter() as any;
  let command: any;
  Object.assign(child, { stdout, stderr: new PassThrough(), stdin: new Writable({ write(chunk, _, callback) { command = JSON.parse(String(chunk)); callback(); } }) });
  fixture.spawn.mockReturnValue(child);
  const provider = new PiRouterProvider({ executable: 'fake-pi', cwd: mkdtempSync(join(tmpdir(), 'router-pi-test-')), env: {}, owner: 'ou_owner' });
  const context = { conversationId: 'c', message: 'task', projects: [], task: {}, shared: [] } as unknown as RouterContext;
  const event = (value: any) => stdout.write(JSON.stringify(value) + '\n');
  return { child, provider, context, event, command: () => command };
}
afterEach(() => vi.clearAllMocks());
describe('hidden Pi RPC transport', () => {
  it('requires settlement, reuses the process, and starts with tools/resources disabled', async () => {
    const f = setup(); let done = false;
    const first = f.provider.decide(f.context, AbortSignal.timeout(1000)).then(value => { done = true; return value; });
    f.event({ type: 'response', id: f.command().id, success: true, data: { disposition: 'started' } });
    f.event({ type: 'message_end', message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: JSON.stringify(answer) }] } });
    f.event({ type: 'agent_end' }); await Promise.resolve(); expect(done).toBe(false);
    f.event({ type: 'agent_settled' }); expect(await first).toEqual(answer);
    const second = f.provider.decide(f.context, AbortSignal.timeout(1000));
    f.event({ type: 'response', id: f.command().id, success: true });
    f.event({ type: 'message_end', message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: JSON.stringify(answer) }] } });
    f.event({ type: 'agent_settled' }); await second;
    expect(fixture.spawn).toHaveBeenCalledTimes(1);
    const args = fixture.spawn.mock.calls[0][1];
    expect(args).toEqual(expect.arrayContaining(['--mode', 'rpc', '--no-tools', '--no-extensions', '--no-session', '--no-mcp']));
    expect(fixture.spawn.mock.calls[0][2].env.BOTMUX_OWNER_OPEN_ID).toBe('ou_owner');
    f.provider.close();
  });
  it('rejects forbidden UI requests and failed model results', async () => {
    const f = setup();
    const request = f.provider.decide(f.context, AbortSignal.timeout(1000));
    f.event({ type: 'extension_ui_request', method: 'input' });
    await expect(request).rejects.toThrow();
    const next = f.provider.decide(f.context, AbortSignal.timeout(1000));
    f.event({ type: 'response', id: f.command().id, success: true });
    f.event({ type: 'message_end', message: { role: 'assistant', stopReason: 'error', content: [] } });
    f.event({ type: 'agent_settled' }); await expect(next).rejects.toThrow();
    f.provider.close();
  });
  it('aborts an unresponsive run and closes active waiters', async () => {
    const f = setup(); const controller = new AbortController();
    const request = f.provider.decide(f.context, controller.signal); controller.abort();
    await expect(request).rejects.toThrow();
    const next = f.provider.decide(f.context, AbortSignal.timeout(1000));
    f.provider.close(); await expect(next).rejects.toThrow();
  });
});
