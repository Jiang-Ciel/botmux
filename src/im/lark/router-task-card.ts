import type { RouterTask } from '../../services/default-router.js';
export interface RouterBoardBinding {
  id: string; app: string; owner: string; conversation: string; chatId: string;
  chatType: 'p2p' | 'group'; scope: 'chat' | 'thread'; anchor: string; sourceMessageId: string;
  messageId?: string; delivery?: 'pending' | 'active' | 'uncertain'; hash?: string;
}
export const taskStates: Record<RouterTask['state'], string> = {
  collecting: '收集需求', proposed: '待批准方案', dispatching: '派发待核实', running: '执行中',
  review: '待验收', blocked: '阻塞待核查', cancelled: '已取消', completed: '已完成',
};
const plain = (content: string) => ({ tag: 'plain_text', content });
const safe = (s: string) => s.replaceAll('<', '＜').replaceAll('>', '＞').replace(/[\\`*_[\]!~&]/g, c => `\\${c}`);
const md = (content: string) => ({ tag: 'markdown', content });
const value = (b: RouterBoardBinding, t: RouterTask | undefined, op: string) => ({ action: 'router_task_card', board: b.id,
  op, ...(t ? { task: t.id, revision: String(t.revision) } : {}) });
const button = (label: string, v: Record<string, string>, submit = false) => ({ tag: 'button', name: `button_${v.op}_${v.task ?? 'board'}`,
  text: plain(label), type: submit ? 'primary' : 'default', ...(submit ? { form_action_type: 'submit' } : {}),
  behaviors: [{ type: 'callback', value: v }] });
export function routerTaskSummaryCard(title: string, coreWork: string, status?: string) {
  return { schema: '2.0', config: { wide_screen_mode: true, enable_forward: false },
    header: { template: 'blue', title: plain(title) },
    body: { elements: [md(safe(coreWork)), ...(status ? [md(safe(status))] : [])] } };
}
export function routerTaskCard(b: RouterBoardBinding, tasks: RouterTask[], options: { imageKey?: string; taskId?: string; notice?: string; projects?: Array<{ id: string; title: string }>; tools?: Array<{ name: string; subject?: string; completed?: boolean }> } = {}) {
  const detail = tasks.find(t => t.id === options.taskId);
  const elements: any[] = [];
  if (options.notice) elements.push(md(safe(options.notice)));
  if (!detail) {
    elements.push(md(`任务 **${tasks.length}** · 执行 **${tasks.filter(t => t.state === 'running').length}** · 待审核 **${tasks.filter(t => ['proposed', 'review'].includes(t.state)).length}**\n总览自动更新；打开独立节点详情后，填写内容不会被后台刷新覆盖。`));
    if (options.imageKey) elements.push({ tag: 'img', img_key: options.imageKey, alt: plain('任务生命周期图；各行独立，未推断跨任务依赖') });
    elements.push(md('图中箭头仅表示生命周期，不代表跨任务依赖。首版施工细节展示真实工具事件；尚未接入完整 todo 依赖图。'));
    for (const t of tasks.slice(-12).reverse()) {
      elements.push({ tag: 'column_set', columns: [
        { tag: 'column', width: 'weighted', weight: 1, elements: [md(`**${safe(t.title || '需求收集中')}**\n${t.projectOffer && t.state !== 'cancelled' ? '待创建 / 归并对话 Project' : t.waitingInput ? '等待补充输入' : t.queued ? '排队等待空闲' : taskStates[t.state]} · ${t.id.slice(0, 8)} · r${t.revision}`)] },
        { tag: 'column', width: 'auto', elements: [button('查验节点', value(b, t, 'view'))] },
      ] });
    }
    if (tasks.length > 12) elements.push(md('总览只展开最近 12 项；历史任务仍保留在账本。'));
    elements.push(button('刷新状态', value(b, undefined, 'refresh')));
  } else {
    const t = detail;
    elements.push(md(`**${safe(t.title || '需求收集中')}**\n状态：${taskStates[t.state]} · r${t.revision}\n任务 ID：${t.id}\n方案版本：v${t.proposalRevision ?? t.revision}`));
    const panel = (title: string, text: string) => ({ tag: 'collapsible_panel', expanded: false,
      header: { title: plain(title) }, elements: [md(safe(text.slice(0, 12000)) || '暂无记录')] });
    elements.push(panel('需求与完整方案', `项目：${t.project}\n执行目录：${t.isolated ? '独立临时目录（不保证只读）' : '项目 checkout'}\n\n${t.instruction}\n\n原始需求：\n${t.history.filter(h => h.role === 'user').slice(0, 3).map(h => h.text).join('\n')}`));
    elements.push(panel('执行节点 / session / 最近工具事件', `执行轮次：${t.attempt?.id ?? '未派发'}\nsession：${t.attempt?.sessionId ?? '未创建'}\n\n${options.tools?.map(tool => `${tool.completed ? '✓ 已返回' : '◐ 调用中'} ${tool.name} ${tool.subject ?? ''}`).join('\n') || '暂无公开工具事件。不展示隐藏推理，不猜测施工百分比。'}\n\n结果请查阅对应任务交付消息。`));
    elements.push(panel('审核记录', t.audit?.map(a => `${a.at} · ${a.action}\n${a.text ?? ''}`).join('\n\n') ?? '暂无卡片审核记录'));
    if (t.projectOffer && t.state !== 'cancelled') {
      const fields: any[] = [{ tag: 'input', name: 'note', input_type: 'text', width: 'fill', default_value: t.projectOffer.title, placeholder: plain('对话 Project 名称（不是仓库路径）') },
        button('创建长期 Project', value(b, t, 'create_project'), true)];
      for (const p of options.projects ?? []) if (t.projectOffer.candidates.includes(p.id)) fields.push(button(`归并到 ${p.title}`, value(b, t, `merge_project:${p.id}`), true));
      elements.push(md('连续研讨使用唯一 task/session。创建或归并由你确认，后续问题直接在该 Project 迭代。'));
      elements.push({ tag: 'form', name: 'router_project', elements: fields });
      elements.push(button('不创建 Project，直接执行', value(b, t, 'direct_task')));
    }
    const ops = t.projectOffer ? [] : t.approvalRequired ? [['批准本轮操作', 'approve'], ['提交修改意见', 'supplement']] : t.state === 'proposed' ? [['批准执行', 'approve'], ['取消方案', 'cancel'], ['提交修改意见', 'supplement']]
      : t.state === 'review' ? [['验收通过', 'accept'], ['提交验收 / 返工意见', 'supplement']]
      : t.state === 'collecting' ? [['补充需求', 'supplement'], ['取消任务', 'cancel']] : t.conversationProjectId && t.state === 'running' ? [['补充研讨问题', 'supplement']] : [];
    if (ops.length) {
      const fields: any[] = [];
      if (t.approvalRequired || ['proposed', 'review'].includes(t.state)) fields.push({ tag: 'checker', name: 'confirmed', checked: false,
        text: plain(t.state === 'proposed' ? '我已查看完整方案并确认授权范围' : '我已核验交付结果与验收条件'), overall_checkable: true,
        checked_style: { show_strikethrough: false, opacity: 1 } });
      fields.push({ tag: 'input', name: 'note', input_type: 'multiline_text', width: 'fill', required: false,
        max_length: 1000, placeholder: plain('补充问题 / 迭代需求（原会话空闲后继续）') });
      fields.push(...ops.map(([label, op]) => button(label, value(b, t, op), true)));
      elements.push({ tag: 'form', name: 'router_review', elements: fields });
      elements.push(md('勾选本身不代表批准，必须点击提交。状态或版本变化后，旧表单操作会被拒绝。长期 Project 的补充将在原 session/task 继续，不冻结旧需求范围。'));
    } else if (!t.projectOffer || t.state === 'cancelled') elements.push(md('该状态暂不允许本卡修改。执行问答请回复原受管问题；阻塞或派发不确定时不自动重试。'));
    elements.push(button('刷新本节点', value(b, t, 'view')));
  }
  return { schema: '2.0', config: { wide_screen_mode: true, enable_forward: false, update_multi: true },
    header: { template: detail?.state === 'completed' ? 'green' : 'blue', title: plain(detail ? 'Router · 节点查验与审核' : 'Router · 任务交互看板') }, body: { elements } };
}
