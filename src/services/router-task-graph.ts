import type { RouterTask } from './default-router.js';
import { taskStates } from '../im/lark/router-task-card.js';
/** Bounded lifecycle DAG preview, not a task-dependency inference. Native canvas stays
 * lazy (same strategy as terminal screenshots) for installations without the addon. */
export async function routerTaskGraph(tasks: RouterTask[]): Promise<Buffer> {
  const { createCanvas, GlobalFonts } = await import('@napi-rs/canvas');
  const { existsSync } = await import('node:fs');
  for (const path of ['/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc', '/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc']) {
    if (existsSync(path)) { GlobalFonts.registerFromPath(path, 'RouterSans'); break; }
  }
  const visible = tasks.slice(-8).reverse();
  const width = 1080, height = 90 + Math.max(1, visible.length) * 112;
  const canvas = createCanvas(width, height); const c = canvas.getContext('2d');
  c.fillStyle = '#f5f7fc'; c.fillRect(0, 0, width, height);
  c.font = 'bold 24px RouterSans, sans-serif'; c.fillStyle = '#25324c'; c.fillText('Router 任务生命周期 · 独立并行分支', 24, 38);
  const labels = ['需求', '方案审核', '后台执行', '结果验收', '完成'];
  visible.forEach((t, row) => {
    const y = 105 + row * 112;
    c.fillStyle = '#25324c'; c.font = '18px RouterSans, sans-serif';
    c.fillText(`${t.id.slice(0, 8)} · ${t.title.slice(0, 44) || '需求收集中'}`, 24, y - 20);
    const active = t.state === 'collecting' ? 0 : t.state === 'proposed' ? 1
      : ['dispatching', 'running', 'blocked'].includes(t.state) ? 2 : t.state === 'review' ? 3 : 4;
    labels.forEach((label, i) => {
      const x = 24 + i * 207;
      if (i < labels.length - 1) {
        c.strokeStyle = '#9caac5'; c.lineWidth = 2; c.beginPath(); c.moveTo(x + 172, y + 24); c.lineTo(x + 200, y + 24); c.stroke();
        c.beginPath(); c.moveTo(x + 194, y + 18); c.lineTo(x + 200, y + 24); c.lineTo(x + 194, y + 30); c.stroke();
      }
      c.fillStyle = i === active ? (t.state === 'blocked' ? '#c97b15' : t.state === 'cancelled' ? '#7a8497' : '#3370ff') : i < active && t.state !== 'cancelled' ? '#e0f3e6' : '#e8edf5';
      c.fillRect(x, y, 172, 48); c.fillStyle = i === active ? '#ffffff' : '#53617b';
      c.font = '18px RouterSans, sans-serif'; c.fillText(i === active ? taskStates[t.state] : label, x + 14, y + 30);
    });
  });
  if (!visible.length) { c.font = '20px RouterSans, sans-serif'; c.fillStyle = '#53617b'; c.fillText('等待新的任务提案', 24, 120); }
  return canvas.encode('png');
}
