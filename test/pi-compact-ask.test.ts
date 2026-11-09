import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseAskBody } from '../src/core/ask-api.js';
import { parseAskQuestions } from '../src/core/ask-questions.js';
import { parseAskFormValues } from '../src/core/ask-form.js';
import { buildAskFormElements } from '../src/im/lark/ask-form-elements.js';
import { _resetForTest, registerAsk, setCardDispatcher, setCanTalkChecker, setAskPersistStore, submitAskForm } from '../src/core/ask-broker.js';
import pi from '../src/core/ask-hook/pi.js';
import { turnReplyCardRequestBytes } from '../src/im/lark/turn-reply-card-size.js';
import { buildAskCard } from '../src/im/lark/ask-card.js';
import { turnReplyAskSummary } from '../src/im/lark/turn-reply-ask-elements.js';
import { AskDispatchError } from '../src/core/ask-types.js';
import type { AskQuestion, PendingAsk } from '../src/core/ask-types.js';
const qs: AskQuestion[] = [{ prompt: 'Direction?', multiSelect: false, options: [{ key: 'a', label: 'Alpha' }, { key: 'b', label: 'Beta' }], customInput: { maxLength: 1000 } }];
const base = { larkAppId: 'cli_test', chatId: 'oc_test', rootMessageId: 'om_test', sessionId: 'sid', questions: qs, timeoutMs: 5000, originKind: 'pi_hook' };
let sent: PendingAsk;
beforeEach(() => { vi.useFakeTimers(); _resetForTest(); setCanTalkChecker((_a, _c, by) => by === 'ou_ok'); setCardDispatcher({ send: async ask => { sent = ask; return { messageId: 'om_card' }; }, onSettle() {} }); });
afterEach(() => { _resetForTest(); vi.useRealTimers(); });
describe('Pi compact form opt-in', () => {
  it('validates its versioned hook, restricts the schema to Pi origin, leaves other inputs unchanged', () => {
    expect(pi.parseQuestions({ hook_event_name: 'pi-questions/request-v1', tool_input: { questions: qs } })?.questions).toEqual(qs);
    expect(pi.parseQuestions({ hook_event_name: 'user-questions/request', tool_input: { questions: qs } })).toBeNull();
    expect(parseAskBody(base)).toHaveProperty('questions');
    expect(parseAskBody({ ...base, originKind: 'hook' })).toEqual({ error: 'bad_input' });
    expect(parseAskBody({ ...base, originKind: 'explicit' })).toEqual({ error: 'bad_input' });
    expect(parseAskQuestions([{ ...qs[0], customInput: { maxLength: 0 } }])).toBe('bad_input');
    expect(parseAskQuestions([{ ...qs[0], input: { type: 'text' } }])).toBe('bad_input');
  });
  it('returns options OR custom text for single choice, rejects incomplete and ambiguous values', () => {
    expect(parseAskFormValues(qs, { q0_o1: true })).toEqual({ answers: [['b']], inputs: [null] });
    expect(parseAskFormValues(qs, { q0_text: '自己的答案' })).toEqual({ answers: [[]], inputs: ['自己的答案'] });
    for (const raw of [{}, { q0_text: ' ' }, { q0_o0: true, q0_o1: true }, { q0_o0: true, q0_text: 'custom' }, { q0_o0: 'true' }, { q0_o2: true }, { q0: 'a' }, { q0_text: 'x'.repeat(1001) }]) expect(parseAskFormValues(qs, raw)).toBeNull();
  });
  it('supports multi choice plus independent custom text in the same atomic form', () => {
    const multi = [{ ...qs[0], multiSelect: true }, qs[0]];
    expect(parseAskFormValues(multi, { q0_o0: true, q0_o1: true, q0_text: 'extra', q1_text: 'second' }))
      .toEqual({ answers: [['a', 'b'], []], inputs: ['extra', 'second'] });
  });
  it('renders labeled client-side point controls and a text field without draft-erasing toggle callbacks', async () => {
    const result = registerAsk(base); await vi.advanceTimersByTimeAsync(0);
    const elements = buildAskFormElements(sent, 'zh');
    const form = elements.find(e => e.tag === 'form');
    const checks = form!.elements.filter((e: any) => e.tag === 'checker');
    expect(checks.map((c: any) => c.text.content)).toEqual(['Alpha', 'Beta']);
    expect(checks.every((c: any) => !c.behaviors && !c.checked)).toBe(true);
    expect(form!.elements.some((e: any) => e.tag === 'select_static')).toBe(false);
    expect(form!.elements.find((e: any) => e.tag === 'input').name).toBe('q0_text');
    expect(submitAskForm({ askId: sent.askId, nonce: sent.nonce, by: 'ou_bad', values: { q0_text: 'wrong' } })).toBe('unauthorized');
    expect(submitAskForm({ askId: sent.askId, nonce: sent.nonce, by: 'ou_ok', values: { q0_text: 'answer' } })).toBe('accepted');
    const resolved = await result;
    expect(resolved).toMatchObject({ kind: 'answered', inputs: ['answer'] });
    if (resolved.kind === 'answered') expect(JSON.parse(pi.formatAnswer(resolved.answers, { questions: qs, raw: {} }, null, resolved.customAnswers, resolved.inputs)).answers[0].custom).toBe('answer');
  });
  it('a disconnected Pi waiter invalidates the form without a later continuation', async () => {
    const controller = new AbortController(); const result = registerAsk(base, controller.signal);
    await vi.advanceTimersByTimeAsync(0); controller.abort();
    expect(await result).toMatchObject({ kind: 'invalidated' });
    expect(submitAskForm({ askId: sent.askId, nonce: sent.nonce, by: 'ou_ok', values: { q0_text: 'late' } })).not.toBe('accepted');
  });
});

describe('independent-review requested fake-clock probes', () => {
  it('abort while send pending patches terminal state when late messageId arrives', async () => {
    let deliver!: (value: { messageId: string }) => void;
    const settled: Array<{ ask: PendingAsk; result: unknown }> = [];
    setCardDispatcher({ send: async ask => { sent = ask; return new Promise(r => { deliver = r; }); }, onSettle: (ask, result) => { settled.push({ ask, result }); } });
    const controller = new AbortController(); const result = registerAsk(base, controller.signal);
    await vi.advanceTimersByTimeAsync(0); controller.abort();
    expect(await result).toMatchObject({ kind: 'invalidated' });
    deliver({ messageId: 'om_late' }); await vi.advanceTimersByTimeAsync(0);
    expect(settled.some(x => x.ask.cardMessageId === 'om_late')).toBe(true);
    expect(submitAskForm({ askId: sent.askId, nonce: sent.nonce, by: 'ou_ok', values: { q0_text: 'late' } })).not.toBe('accepted');
  });
  it.each(['throw', 'reject'])('onSettle %s cannot hide or duplicate successful answer', async mode => {
    const handler = vi.fn(() => { if (mode === 'throw') throw Error('patch'); return Promise.reject(Error('patch')); });
    setCardDispatcher({ send: async ask => { sent = ask; return { messageId: 'om_card' }; }, onSettle: handler });
    const result = registerAsk(base); await vi.advanceTimersByTimeAsync(0);
    const args = { askId: sent.askId, nonce: sent.nonce, by: 'ou_ok', values: { q0_text: 'answer' } };
    expect(submitAskForm(args)).toBe('accepted');
    expect(await result).toMatchObject({ kind: 'answered', inputs: ['answer'] });
    expect(submitAskForm(args)).toBe('already_settled');
    await vi.advanceTimersByTimeAsync(0); expect(handler).toHaveBeenCalledTimes(1);
  });
  it.each(['abort', 'timeout'])('retry backoff crossing %s causes no further sends', async mode => {
    const send = vi.fn(async ask => { sent = ask; throw new AskDispatchError('network', true); });
    setCardDispatcher({ send, onSettle() {} });
    const controller = new AbortController();
    const result = registerAsk({ ...base, timeoutMs: 100 }, controller.signal);
    await vi.advanceTimersByTimeAsync(0);
    if (mode === 'abort') controller.abort(); else await vi.advanceTimersByTimeAsync(100);
    expect((await result).kind).toBe(mode === 'abort' ? 'invalidated' : 'timedOut');
    await vi.advanceTimersByTimeAsync(10000); expect(send).toHaveBeenCalledTimes(1);
  });
  it('settled card displays both accepted multi-select labels and custom text', async () => {
    const questions = [{ ...qs[0], multiSelect: true }];
    const result = registerAsk({ ...base, questions }); await vi.advanceTimersByTimeAsync(0);
    expect(submitAskForm({ askId: sent.askId, nonce: sent.nonce, by: 'ou_ok', values: { q0_o0: true, q0_o1: true, q0_text: 'Extra' } })).toBe('accepted');
    const resolved = await result;
    const display = JSON.stringify(buildAskFormElements(sent, 'zh', resolved));
    expect(display).toContain('Alpha'); expect(display).toContain('Beta'); expect(display).toContain('Extra');
    const summary = turnReplyAskSummary({ ask: sent, result: resolved } as any);
    expect(summary).toContain('Alpha'); expect(summary).toContain('Beta'); expect(summary).toContain('Extra');
  });
});

it('Pi hook never persists/handoffs despite a surviving backend and requestId', async () => {
  const put = vi.fn(); setAskPersistStore({ put, remove() {}, list() { return []; } });
  const controller = new AbortController();
  const result = registerAsk({ ...base, backendSurvivesRestart: true, requestId: 'pi-request' }, controller.signal);
  await vi.advanceTimersByTimeAsync(0);
  expect(put).not.toHaveBeenCalled(); controller.abort();
  expect(await result).toMatchObject({ kind: 'invalidated' });
  await vi.advanceTimersByTimeAsync(10000); expect(put).not.toHaveBeenCalled();
});
it('oversized Pi descriptions/previews/card payloads fail admission rather than truncate a decision', () => {
  for (const option of [{ ...qs[0].options[0], description: 'x'.repeat(501) }, { ...qs[0].options[0], preview: 'x'.repeat(501) }]) {
    expect(parseAskQuestions([{ ...qs[0], options: [option, qs[0].options[1]] }])).toBe('bad_input');
  }
  const full = { ...qs[0], options: qs[0].options.map(o => ({ ...o, description: 'd'.repeat(500), preview: 'p'.repeat(2000) })) };
  expect(parseAskQuestions(Array.from({ length: 4 }, () => full))).toBe('bad_input');
});

it('CJK previews exceeding UTF8 budget fail closed even below UTF16 budget', () => {
  const q = { ...qs[0], options: qs[0].options.map(o => ({ ...o, description: '说'.repeat(500), preview: '汉'.repeat(500) })) };
  const batch = [q, q];
  expect(JSON.stringify(batch).length).toBeLessThan(5000);
  expect(Buffer.byteLength(JSON.stringify(batch))).toBeGreaterThan(4000);
  expect(parseAskQuestions(batch)).toBe('bad_input');
});

it('bounds wrapper-heavy and escaped Pi forms to fit the card transport budget', async () => {
  const short = { ...qs[0], options: [0,1,2,3].map(i => ({ key: String(i), label: 'Choice', description: 'Detail', preview: 'Preview' })) };
  expect(parseAskQuestions(Array.from({ length: 20 }, () => short))).toBe('bad_input');
  const preview = { ...qs[0], options: qs[0].options.map(o => ({ ...o, preview: String.fromCharCode(92).repeat(400) })) };
  const parsed = parseAskQuestions([preview]); expect(typeof parsed).not.toBe('string');
  const result = registerAsk({ ...base, questions: [preview] }); await vi.advanceTimersByTimeAsync(0);
  const bytes = turnReplyCardRequestBytes(buildAskCard(sent), base.chatId);
  console.log('escaped form bytes', bytes); expect(bytes).toBeLessThan(25000);
  const four = Array.from({ length: 4 }, () => short);
  const second = registerAsk({ ...base, questions: four }); await vi.advanceTimersByTimeAsync(0);
  const wrapperBytes = turnReplyCardRequestBytes(buildAskCard(sent), base.chatId);
  console.log('4x4 wrapper form bytes', wrapperBytes); expect(wrapperBytes).toBeLessThan(25000);
  await vi.advanceTimersByTimeAsync(5000); await result; await second;
});
