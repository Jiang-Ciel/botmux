import type { HookAskAdapter } from './types.js';
import { parseAskQuestions } from '../ask-questions.js';

/** Versioned opt-in; do not reinterpret any other CLI's existing hooks. */
const piAdapter: HookAskAdapter = {
  parseQuestions(payload) {
    if (!payload || typeof payload !== 'object') return null;
    const raw = payload as { hook_event_name?: unknown; tool_input?: { questions?: unknown } };
    if (raw.hook_event_name !== 'pi-questions/request-v1') return null;
    const questions = parseAskQuestions(raw.tool_input?.questions);
    if (typeof questions === 'string' || questions.some(q => !q.customInput)) return null;
    return { questions, raw: {} };
  },
  formatAnswer(answers, parsed, comment, customAnswers, inputs) {
    return JSON.stringify({ answers: parsed.questions.map((_q, i) => ({
      id: `q${i}`, selected: [...(answers[i] ?? [])],
      ...((inputs?.[i] ?? customAnswers?.[i]) ? { custom: inputs?.[i] ?? customAnswers?.[i] } : !answers[i]?.length && comment?.trim() ? { custom: comment } : {}),
    })) });
  },
  passthrough() { return ''; },
};
export default piAdapter;
