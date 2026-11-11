import { ROUTER_STAGE_LABELS } from './router-progress-labels.js';
import { mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWriteFileSync } from '../utils/atomic-write.js';

export type RouterStage = 'queued' | 'context' | 'submitted' | 'analyzing' | 'validating' | 'completed' | 'failed' | 'interrupted';
export interface RouterProgress {
  id: string; routerSessionId: string; conversation: string; owner: string; sourceMessageId: string;
  prompt: string; stage: RouterStage; startedAt: number; updatedAt: number; lastActivityAt: number; sequence: number;
  finishedAt?: number; taskId?: string; summary?: string;
}
export type RouterProgressSink = (progress: RouterProgress) => void;
export function saveRouterProgress(root: string, progress: RouterProgress): void {
  const dir = join(root, 'analyses'); mkdirSync(dir, { recursive: true, mode: 0o700 });
  atomicWriteFileSync(join(dir, `${progress.id}.json`), JSON.stringify(progress), { mode: 0o600, durable: true, followTargetSymlink: false });
}
export function listRouterProgress(root: string): RouterProgress[] {
  const dir = join(root, 'analyses');
  try { return readdirSync(dir).filter(f => /^[a-f0-9-]+\.json$/.test(f)).flatMap(f => {
    try { return [JSON.parse(readFileSync(join(dir, f), 'utf8')) as RouterProgress]; } catch { return []; }
  }).sort((a, b) => b.startedAt - a.startedAt).slice(0, 200); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return []; throw e; }
}
export function interruptRouterProgress(root: string, owner: string): void {
  for (const p of listRouterProgress(root).filter(p => p.owner === owner && !p.finishedAt)) {
    const now = Date.now(); saveRouterProgress(root, { ...p, stage: 'interrupted', finishedAt: now, updatedAt: now,
      sequence: p.sequence + 1, summary: 'Router 进程重启或运行已中断；尚未自动重派执行。' });
  }
}
export function routerProgressCard(p: RouterProgress): object {
  const end = p.finishedAt ?? Date.now();
  return { config: { wide_screen_mode: true }, header: { title: { tag: 'plain_text', content: `Router｜${ROUTER_STAGE_LABELS[p.stage]}` },
    template: p.stage === 'failed' || p.stage === 'interrupted' ? 'red' : p.stage === 'completed' ? 'green' : 'blue' },
    elements: [{ tag: 'div', text: { tag: 'plain_text', content: `对应请求：${p.prompt.slice(0, 240)}\n耗时：${Math.max(0, Math.floor((end - p.startedAt) / 1000))} 秒\n最近活动：${new Date(p.lastActivityAt).toLocaleTimeString('zh-CN')}\n${p.summary ?? 'Router 分析不代表任务已开始执行。'}\n运行：${p.id.slice(0, 8)}` } }] };
}
