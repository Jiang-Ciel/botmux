import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DefaultRouter, routerNeedsInput, routerExecutionFacts, type RouterDecision, type RouterInput } from '../src/services/default-router.js';

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'router-continuity-'));
  const project = join(root, 'project'); mkdirSync(project);
  const decide = vi.fn(async (): Promise<RouterDecision> => ({ action: 'propose', title: '格式化', message: '- 保留逻辑\n- 验收完整代码块', project, instruction: '格式化用户代码，不执行', isolated: true }));
  const router = new DefaultRouter(root, { decide });
  const input: RouterInput = { conversation: 'window', owner: 'owner', messageId: 'original', text: 'import os\n   print("中文")', projects: [project], executions: [] };
  const tasks = () => JSON.parse(readFileSync(join(root, 'ledger.json'), 'utf8')).tasks;
  return { root, project, router, decide, input, tasks };
}
const idle = { sessionId: 'original-session', busy: false, waiting: false, closed: false, interrupted: false, delivered: true, turnId: 'original' };

describe('router task continuity and full input', () => {
  it('dispatches clear requests without approval and preserves raw material beyond old limits', async () => {
    const f = setup(); const code = 'import os\n' + '# 中文注释\n'.repeat(6000) + 'print("末尾必须保留")\n';
    const first = await f.router.handle({ ...f.input, text: code });
    if (first.kind !== 'dispatch') throw new Error('missing dispatch');
    expect(first.instruction).toContain(JSON.stringify(code));
    expect(first.summary).toBeTruthy(); expect(f.tasks()[0].approvalRequired).toBe(false);
    expect(f.tasks()[0].history[0].text).toBe(code);
  });
  it('retains all clarification messages and does not dispatch ambiguous requests', async () => {
    const f = setup(); f.decide.mockResolvedValueOnce({ action: 'clarify', message: '目标是哪一个？', title: '', project: '', instruction: '' });
    expect((await f.router.handle(f.input)).kind).toBe('reply');
    const result = await f.router.handle({ ...f.input, messageId: 'answer', text: '完整输出，不执行脚本' });
    if (result.kind !== 'dispatch') throw new Error('missing dispatch');
    expect(result.instruction).toContain(JSON.stringify(f.input.text));
    expect(result.instruction).toContain('完整输出，不执行脚本'); expect(f.tasks()).toHaveLength(1);
  });
  it('keeps genuine approval boundaries and carries original material after approval', async () => {
    const f = setup(); f.decide.mockResolvedValueOnce({ action: 'propose', title: '删除', message: '确认删除范围', project: f.project, instruction: 'delete only specified data', requiresApproval: true });
    expect((await f.router.handle(f.input)).kind).toBe('reply');
    const result = await f.router.handle({ ...f.input, messageId: 'approve', text: '批准执行' });
    if (result.kind !== 'dispatch') throw new Error('missing dispatch');
    expect(result.instruction).toContain(JSON.stringify(f.input.text));
  });
  it('uses the same task and execution session for requested context, also after ledger restart', async () => {
    const f = setup(); const first = await f.router.handle(f.input);
    if (first.kind !== 'dispatch') throw new Error('missing dispatch');
    await f.router.finish(first.attemptId, idle.sessionId, true);
    const facts = { ...idle, response: '[BOTMUX_TASK_WAITING] 请发送完整脚本' };
    await f.router.reconcile([facts]); expect(f.tasks()[0].state).toBe('running'); expect(f.tasks()[0].waitingInput).toBe(true);
    f.decide.mockResolvedValueOnce({ action: 'continue', title: '', project: '', instruction: '', message: '已补充', targetTaskId: first.taskId });
    const restored = new DefaultRouter(f.root, { decide: f.decide });
    const result = await restored.handle({ ...f.input, messageId: 'supplement', text: 'import os\nprint("完整脚本")', executions: [facts] });
    if (result.kind !== 'dispatch') throw new Error('missing continuation');
    expect(result.sessionId).toBe(idle.sessionId); expect(result.taskId).toBe(first.taskId); expect(f.tasks()).toHaveLength(1);
    expect(result.instruction).toContain('完整脚本'); expect(result.instruction).toContain(JSON.stringify(f.input.text));
    await restored.bind(result.attemptId, idle.sessionId); await restored.finish(result.attemptId, idle.sessionId, true);
    await restored.reconcile([{ ...idle, turnId: 'supplement', response: '[BOTMUX_TASK_RESULT]\n```python\nprint(1)\n```' }]);
    expect(f.tasks()[0].state).toBe('review');
    expect((await restored.handle({ ...f.input, messageId: 'duplicate', text: '验收完成', executions: [{ ...idle, turnId: 'original' }] })).kind).toBe('reply');
    expect(f.tasks()[0].state).toBe('review');
  });
  it('does not accept an input request as a delivered result, including legacy plain-text questions', async () => {
    const f = setup(); const first = await f.router.handle(f.input);
    if (first.kind !== 'dispatch') throw new Error('missing dispatch'); await f.router.finish(first.attemptId, idle.sessionId, true);
    const facts = { ...idle, response: '请发送需要格式化的完整 Python 脚本，并确认批准执行。' };
    const result = await f.router.handle({ ...f.input, messageId: 'accept', text: '验收完成', executions: [facts] });
    expect(result.kind).toBe('reply'); expect(f.tasks()[0].state).toBe('running');
    expect(routerNeedsInput('```python\n# 请发送完整脚本\n```')).toBe(false);
    expect(routerNeedsInput('[BOTMUX_TASK_RESULT] 如需改动请提供反馈')).toBe(false);
    expect(routerExecutionFacts({ session: { sessionId: 's' }, lastScreenContent: facts.response } as any).waiting).toBe(true);
  });
  it.each([{ busy: true }, { closed: true }, { interrupted: true }])('never opens a replacement session when original facts prevent continuation: %o', async change => {
    const f = setup(); const first = await f.router.handle(f.input);
    if (first.kind !== 'dispatch') throw new Error('missing dispatch'); await f.router.finish(first.attemptId, idle.sessionId, true);
    f.decide.mockResolvedValueOnce({ action: 'continue', title: '', project: '', instruction: '', message: 'continue' });
    expect((await f.router.handle({ ...f.input, messageId: 'context', text: '补充代码', executions: [{ ...idle, ...change }] })).kind).toBe('reply');
    expect(f.tasks()).toHaveLength(1); expect(f.tasks()[0].attempt.id).toBe(first.attemptId);
  });
  it('keeps independent new tasks separate without old task input contamination', async () => {
    const f = setup(); const first = await f.router.handle(f.input);
    if (first.kind !== 'dispatch') throw new Error('missing dispatch'); await f.router.finish(first.attemptId, idle.sessionId, true);
    f.decide.mockResolvedValueOnce({ action: 'propose', title: '天气', message: '- 查询天气', project: f.project, instruction: '查天气', newTask: true, isolated: true });
    const result = await f.router.handle({ ...f.input, messageId: 'new', text: '另外查南京天气', executions: [{ ...idle, busy: true, delivered: false }] });
    if (result.kind !== 'dispatch') throw new Error('missing independent dispatch');
    expect(result.taskId).not.toBe(first.taskId); expect(result.sessionId).toBeUndefined(); expect(result.instruction).not.toContain(JSON.stringify(f.input.text));
    expect(f.tasks()[0].history.some((h: any) => h.text === '另外查南京天气')).toBe(false);
  });
  it('excludes only its own waiting executor from the project busy fence', async () => {
    const f = setup(); f.decide.mockResolvedValueOnce({ action: 'propose', title: 'A', message: '- A', project: f.project, instruction: 'A' });
    const first = await f.router.handle(f.input); if (first.kind !== 'dispatch') throw new Error('missing');
    await f.router.finish(first.attemptId, idle.sessionId, true);
    f.decide.mockResolvedValueOnce({ action: 'continue', title: '', message: 'more', project: '', instruction: '', targetTaskId: first.taskId });
    const busy = vi.fn((_project: string, exclude?: string) => exclude !== idle.sessionId);
    const result = await f.router.handle({ ...f.input, messageId: 'more', text: 'more',
      executions: [{ ...idle, response: '[BOTMUX_TASK_WAITING] 请补充代码', waiting: true }], projectBusy: busy });
    expect(result.kind).toBe('dispatch'); expect(busy).toHaveBeenCalledWith(f.project, idle.sessionId);
  });
  it.each(['revoked', 'fenced'])('checks the current project boundary before continuation: %s', async boundary => {
    const f = setup(); f.decide.mockResolvedValueOnce({ action: 'propose', title: 'A', message: '- A', project: f.project, instruction: 'A' });
    const first = await f.router.handle(f.input); if (first.kind !== 'dispatch') throw new Error('missing');
    await f.router.finish(first.attemptId, idle.sessionId, true);
    f.decide.mockResolvedValueOnce({ action: 'continue', title: '', message: 'more', project: '', instruction: '', targetTaskId: first.taskId });
    const result = await f.router.handle({ ...f.input, messageId: 'more', text: 'more', executions: [idle],
      projects: boundary === 'revoked' ? [] : f.input.projects, projectBusy: () => boundary === 'fenced' });
    expect(result.kind).toBe('reply'); expect(f.tasks()[0].attempt.id).toBe(first.attemptId);
  });
  it('removes only the source message when executor output arrives during independent task analysis', async () => {
    const f = setup(); const first = await f.router.handle(f.input); if (first.kind !== 'dispatch') throw new Error('missing');
    await f.router.finish(first.attemptId, idle.sessionId, true);
    const facts = { ...idle, busy: true, delivered: false, response: undefined }; await f.router.reconcile([facts]);
    let release!: (d: RouterDecision) => void;
    f.decide.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const pending = f.router.handle({ ...f.input, messageId: 'B', text: 'B private input', executions: [facts] });
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    await f.router.reconcile([{ ...facts, response: 'A concurrent output' }]);
    release({ action: 'propose', title: 'B', message: '- B', instruction: 'B', project: f.project, isolated: true, newTask: true });
    expect((await pending).kind).toBe('dispatch');
    const a = f.tasks().find((t: any) => t.id === first.taskId);
    expect(a.history.some((h: any) => h.text === 'B private input')).toBe(false);
    expect(a.history.some((h: any) => h.text === 'A concurrent output')).toBe(true);
    expect(a.sources.some((source: any) => source.messageId === 'B')).toBe(false);
  });
  it('rolls back a provably unsent continuation but never replays an uncertain bound attempt', async () => {
    const f = setup(); const first = await f.router.handle(f.input);
    if (first.kind !== 'dispatch') throw new Error('missing'); await f.router.finish(first.attemptId, idle.sessionId, true);
    f.decide.mockResolvedValueOnce({ action: 'continue', title: '', project: '', instruction: '', message: 'continue' });
    const continued = await f.router.handle({ ...f.input, messageId: 'supplement', text: 'more code', executions: [idle] });
    if (continued.kind !== 'dispatch') throw new Error('missing');
    await f.router.bind(continued.attemptId, idle.sessionId);
    const restored = new DefaultRouter(f.root, { decide: f.decide });
    expect((await restored.handle({ ...f.input, messageId: 'retry', text: 'more', executions: [idle] })).kind).toBe('reply');
    expect(f.tasks()[0].state).toBe('dispatching');
    await restored.rejectContinuation(continued.attemptId);
    expect(f.tasks()[0].state).toBe('running'); expect(f.tasks()[0].attempt.id).toBe(first.attemptId);
  });
  it('keeps required approval instructions visible in a mixed direct-dispatch batch', async () => {
    const f = setup(); f.decide.mockResolvedValueOnce({ action: 'propose', title: 'mixed', message: '- 两个任务', project: f.project, instruction: 'mixed',
      proposals: [{ title: '查询', instruction: '查询', project: f.project, isolated: true },
        { title: '删除', instruction: '确认删除', project: f.project, requiresApproval: true }] });
    const result = await f.router.handle(f.input);
    if (result.kind !== 'dispatch') throw new Error('missing');
    const pending = f.tasks().find((t: any) => t.approvalRequired);
    expect(result.summary).toContain(pending.id); expect(pending.state).toBe('proposed');
  });
  it('uses the latest explicit outcome and ignores marker literals in code blocks', () => {
    expect(routerNeedsInput('[BOTMUX_TASK_WAITING]\nold question\n[BOTMUX_TASK_RESULT]\nfinished')).toBe(false);
    expect(routerNeedsInput('[BOTMUX_TASK_RESULT]\nold result\n[BOTMUX_TASK_WAITING]\nnew question')).toBe(true);
    expect(routerNeedsInput('```python\nprint("[BOTMUX_TASK_WAITING]")\n```')).toBe(false);
  });
  it('returns every clear independent task for dispatch in a batch', async () => {
    const f = setup(); f.decide.mockResolvedValueOnce({ action: 'propose', title: '天气', message: '- 两个查询', project: f.project, instruction: '查天气',
      proposals: ['北京', '南京'].map(city => ({ title: city, instruction: `查询${city}`, project: f.project, isolated: true })) });
    const result = await f.router.handle(f.input);
    if (result.kind !== 'dispatch') throw new Error('missing dispatch');
    expect(result.additional).toHaveLength(1); expect(f.tasks().every((t: any) => t.state === 'dispatching')).toBe(true);
  });
});
