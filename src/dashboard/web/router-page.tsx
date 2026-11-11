import { useEffect, useState } from 'react';
import { mountReactPage, type PageDisposer } from './react-mount.js';
import type { RouterProgress } from '../../services/router-progress.js';
import { ROUTER_STAGE_LABELS } from '../../services/router-progress-labels.js';

function RouterPage() {
  const [runs, setRuns] = useState<Array<RouterProgress & { botName?: string }>>([]);
  const [error, setError] = useState('');
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    let disposed = false; const controller = new AbortController();
    const refresh = async () => {
      try {
        const response = await fetch('/api/router/analyses', { signal: controller.signal });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();
        if (!disposed) { setRuns(data.analyses ?? []); setError(''); setNow(Date.now()); }
      } catch (e) { if (!disposed) setError(String(e)); }
    };
    void refresh(); const timer = setInterval(() => { void refresh(); }, 3000);
    return () => { disposed = true; clearInterval(timer); controller.abort(); };
  }, []);
  return <section className="page"><h1>Router 后台分析</h1>
    <p>每次请求独立记录。分析进度不代表任务已经开始执行；不展示隐藏推理。</p>
    {error && <p role="alert">读取失败：{error}</p>}
    {!runs.length && <p>暂无分析记录。</p>}
    {[...runs].sort((a,b) => b.startedAt-a.startedAt).map(run => <details key={run.id} open={!run.finishedAt} style={{ marginBottom: 16, padding: 12, border: '1px solid var(--border)' }}>
      <summary>{run.botName}｜{ROUTER_STAGE_LABELS[run.stage]}｜{run.prompt.slice(0, 70)}｜{Math.floor(((run.finishedAt ?? now)-run.startedAt)/1000)} 秒</summary>
      <p>后台 Router 会话：{run.routerSessionId}<br/>分析运行：{run.id}<br/>来源消息：{run.sourceMessageId}<br/>最近活动：{new Date(run.lastActivityAt).toLocaleString()}</p>
      <pre style={{ whiteSpace: 'pre-wrap' }}>{run.prompt}</pre><p>{run.summary}</p>
    </details>)}
  </section>;
}
export function renderRouterPage(root: HTMLElement): PageDisposer { return mountReactPage(root, <RouterPage/>); }
