/**
 * 气象预报解读助手 · LLM 工具调用 Agent（全能模式）
 *
 * 用户配置 OpenAI 兼容 API 后启用：LLM 通过 function calling 自主调度
 * 知识库检索 / 气象 API / 时间 API / 联网搜索四个工具，可回答任意问题。
 *
 * 可控性设计：
 * - 系统提示词要求气象专业问题必须先查知识库并引用来源；
 * - 每一步工具调用都记录到 toolTrace，UI 完整展示（过程透明可审计）；
 * - 最多 6 轮工具调用防止死循环；
 * - 任何环节失败都抛出明确错误，由 UI 层回退到本地引擎。
 */

import { TOOL_SCHEMAS, executeTool, TOOL_REGISTRY } from './tools.js';

const SYSTEM_PROMPT = `你是"气象预报解读助手"，一个严谨但说人话的智能助手。你可以回答任何问题，并配有四个工具：

1. search_knowledge_base：本地权威气象知识库（WMO 指南、GraphCast/Pangu-Weather 论文等）
2. get_weather_forecast：实时天气与逐小时预报（Open-Meteo）
3. get_current_time：当前日期时间（任意时区）
4. web_search：联网搜索公开资料（维基百科 + DuckDuckGo）

工具使用规则：
- 气象概念、预报指标、预警标准、AI 气象模型、气象服务话术类问题：必须先调用 search_knowledge_base，命中则以知识库内容为准作答，并在结尾注明依据来源。
- 询问某地天气或活动适宜性：调用 get_weather_forecast，基于返回的数值和风险项作答，不自行虚构天气数据。
- 涉及"现在/今天/明天"等时间推算：先调用 get_current_time 获取准确日期。
- 气象知识库未命中、或问题属于其它领域：调用 web_search 检索公开资料，基于搜索结果作答并附上来源链接；搜索也没有结果时，如实说明查不到，不要编造。
- 一个问题可以组合多个工具（如"明天杭州天气"= 时间 + 天气）。

回答规则：
- 用简体中文，先给结论，再给解释；专业术语要配通俗解释。
- 事实性内容必须有出处：知识库来源、天气 API 数据或搜索结果链接。凭空编造数字、标准、事实是最严重的错误。
- 涉及安全、作业、出行、应急决策时，提醒用户以当地气象部门最新官方预报和预警为准。
- 输出使用 Markdown（可用 **加粗**、列表、表格）。`;

const MAX_TOOL_ROUNDS = 6;

/**
 * 运行 Agent 循环
 * @param {Array} history  [{role:'user'|'assistant', content}] 最近对话（不含 system）
 * @param {Object} llmConfig {base, key, model}
 * @param {Function} onStatus 进度回调（展示"正在调用 X 工具"）
 * @returns {{content: string, toolTrace: Array<{name,label,args,ok}>}}
 */
export async function runAgent(history, llmConfig, onStatus = () => {}) {
  const { base, key, model } = llmConfig;
  const url = `${base.replace(/\/$/, '')}/chat/completions`;

  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    ...history,
  ];
  const toolTrace = [];

  for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
    onStatus(round === 0 ? '思考中…' : '综合工具结果…');
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model,
        temperature: 0.4,
        messages,
        tools: TOOL_SCHEMAS,
        tool_choice: round === MAX_TOOL_ROUNDS ? 'none' : 'auto',
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`LLM 接口错误 HTTP ${res.status}${body ? `：${body.slice(0, 200)}` : ''}`);
    }
    const json = await res.json();
    const msg = json.choices?.[0]?.message;
    if (!msg) throw new Error('LLM 返回格式异常：缺少 message');

    const toolCalls = msg.tool_calls || [];
    if (!toolCalls.length) {
      return { content: msg.content || '（模型未返回内容）', toolTrace };
    }

    // 执行本轮全部工具调用
    messages.push(msg);
    for (const call of toolCalls) {
      const name = call.function?.name;
      let args = {};
      try { args = JSON.parse(call.function?.arguments || '{}'); } catch { /* 保持空参 */ }
      const label = TOOL_REGISTRY[name]?.label || name;
      onStatus(`${label} 调用中…`);
      const result = await executeTool(name, args);
      toolTrace.push({ name, label, args, ok: !result?.error });
      messages.push({
        role: 'tool',
        tool_call_id: call.id,
        content: JSON.stringify(result),
      });
    }
  }
  throw new Error('工具调用轮次超限');
}
