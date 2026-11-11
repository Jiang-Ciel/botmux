import type { RouterStage } from './router-progress.js';
export const ROUTER_STAGE_LABELS: Record<RouterStage, string> = {
  queued: '排队', context: '准备任务上下文', submitted: '已提交模型', analyzing: '模型已接收，分析中',
  validating: '校验路由决策', completed: '分析完成', failed: '分析失败', interrupted: '运行中断',
};
