/**
 * 气象预报解读助手 · 工具层（LLM function calling 用）
 *
 * 四个工具，全部免 Key、支持浏览器 CORS 直连：
 *  1. search_knowledge_base  本地知识库检索（权威气象知识，带来源）
 *  2. get_weather_forecast   Open-Meteo 实时天气（地名→经纬度→逐小时预报→风险识别）
 *  3. get_current_time       timeapi.io 时区时间（失败回退本机时间）
 *  4. web_search             Wikipedia 搜索 + 摘要，DuckDuckGo 即时应答补充
 */

import { retrieve, confidenceOf, fetchWeather, interpretWeather } from './engine.js';
import { SOURCES } from './kb.js';

/* ============ 工具 Schema（OpenAI function calling 格式） ============ */

export const TOOL_SCHEMAS = [
  {
    type: 'function',
    function: {
      name: 'search_knowledge_base',
      description: '检索本地权威气象知识库（38 条结构化条目，来源为 WMO 指南、GraphCast/Pangu-Weather 论文、Open-Meteo 文档等）。凡涉及气象概念、预报指标、预警标准、AI 气象模型、气象服务话术的问题，必须优先调用本工具，并在回答中引用返回的来源。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '要检索的问题或关键词，中文' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_weather_forecast',
      description: '查询指定地点的实时天气与未来 48 小时逐小时预报（Open-Meteo），返回当前天气、逐小时数据样本和自动识别的风险项。凡用户询问某地当前/未来天气、是否适合某项活动时调用。',
      parameters: {
        type: 'object',
        properties: {
          place: { type: 'string', description: '城市或地区名称，如"深圳"、"杭州"' },
        },
        required: ['place'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_current_time',
      description: '获取指定时区的当前日期和时间。凡用户询问"现在几点""今天几号""某地现在是几点"，或需要基于当前日期推算（如"明天是周几"）时调用。',
      parameters: {
        type: 'object',
        properties: {
          timezone: { type: 'string', description: 'IANA 时区名，如 Asia/Shanghai、America/New_York。默认 Asia/Shanghai' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'web_search',
      description: '联网搜索公开资料（维基百科 + DuckDuckGo 即时应答），返回条目标题、摘要和链接。当问题超出气象知识库范围（如人物、事件、其它领域概念）时调用，用于回答任意主题的问题。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '搜索关键词，尽量简短精确' },
          language: { type: 'string', enum: ['zh', 'en'], description: '搜索语言，默认 zh；英文专有名词可用 en' },
        },
        required: ['query'],
      },
    },
  },
];

/* ============ 工具执行器 ============ */

async function execSearchKnowledgeBase({ query }) {
  const results = retrieve(query, { topK: 3 });
  const confidence = confidenceOf(results);
  if (!results.length || confidence === 'low') {
    return { found: false, note: '知识库中没有与该问题匹配的条目。请改用 web_search，或如实告知用户知识库无依据。' };
  }
  return {
    found: true,
    confidence,
    entries: results.map((r) => ({
      title: r.entry.title,
      category: r.entry.category,
      answer: r.entry.answer,
      sources: r.entry.sources.map((id) => SOURCES[id]?.name || id),
      needsSafetyNote: r.entry.safety,
    })),
  };
}

async function execGetWeather({ place }) {
  const data = await fetchWeather(place);
  if (data.notFound) return { found: false, note: `未找到地点「${place}」，请让用户提供更明确的城市名。` };
  const interp = interpretWeather(data);
  return {
    found: true,
    place: interp.placeName,
    timezone: data.wx.timezone,
    current: interp.current,
    riskLevel: interp.riskLevel,
    risks: interp.risks.map((r) => r.text),
    hourly: interp.rows,
    note: '数据来自 Open-Meteo 模式预报；涉及安全决策时提醒用户复核当地官方预报预警。',
  };
}

async function execGetTime({ timezone = 'Asia/Shanghai' } = {}) {
  try {
    const res = await fetch(`https://timeapi.io/api/Time/current/zone?timeZone=${encodeURIComponent(timezone)}`, { signal: AbortSignal.timeout(8000) });
    if (res.ok) {
      const j = await res.json();
      return {
        source: 'timeapi.io',
        timezone: j.timeZone,
        dateTime: j.dateTime,
        date: `${j.year}-${String(j.month).padStart(2, '0')}-${String(j.day).padStart(2, '0')}`,
        time: j.time,
        dayOfWeek: j.dayOfWeek,
      };
    }
    throw new Error(`HTTP ${res.status}`);
  } catch {
    // 回退本机时钟
    const now = new Date();
    const fmt = new Intl.DateTimeFormat('zh-CN', {
      timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', weekday: 'long', hour12: false,
    });
    return { source: '本机时钟（时间 API 不可用时的回退）', timezone, formatted: fmt.format(now), iso: now.toISOString() };
  }
}

async function execWebSearch({ query, language = 'zh' }) {
  const out = { query, results: [], abstract: null };
  const lang = language === 'en' ? 'en' : 'zh';

  // 1) Wikipedia 搜索（免 Key，CORS OK）
  try {
    const searchUrl = `https://${lang}.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&format=json&origin=*&srlimit=4`;
    const res = await fetch(searchUrl, { signal: AbortSignal.timeout(10000) });
    const j = await res.json();
    const hits = j.query?.search || [];
    out.results = hits.map((h) => ({
      title: h.title,
      snippet: h.snippet.replace(/<[^>]+>/g, ''),
      url: `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(h.title)}`,
      source: `维基百科(${lang})`,
    }));
    // 取第一条的导言摘要，信息量更足
    if (hits.length) {
      const extractUrl = `https://${lang}.wikipedia.org/w/api.php?action=query&prop=extracts&exintro=1&explaintext=1&titles=${encodeURIComponent(hits[0].title)}&format=json&origin=*`;
      const res2 = await fetch(extractUrl, { signal: AbortSignal.timeout(10000) });
      const j2 = await res2.json();
      const pages = j2.query?.pages || {};
      const first = Object.values(pages)[0];
      if (first?.extract) out.abstract = { title: first.title, text: first.extract.slice(0, 1200), source: `维基百科(${lang})` };
    }
  } catch (e) {
    out.wikipediaError = String(e.message || e);
  }

  // 2) DuckDuckGo 即时应答（部分英文专有名词有摘要）
  try {
    const res = await fetch(`https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`, { signal: AbortSignal.timeout(8000) });
    const j = await res.json();
    if (j.AbstractText) {
      out.results.push({ title: j.Heading, snippet: j.AbstractText.slice(0, 600), url: j.AbstractURL, source: `DuckDuckGo(${j.AbstractSource})` });
    }
    if (j.Answer) out.instantAnswer = j.Answer;
  } catch { /* DDG 失败不影响主结果 */ }

  if (!out.results.length && !out.abstract) {
    out.note = '未搜到相关公开资料。可尝试更换关键词（如改用英文专有名词并设 language=en），或如实告知用户没有查到。';
  }
  return out;
}

/** 工具名 → 执行器 + 展示名 */
export const TOOL_REGISTRY = {
  search_knowledge_base: { exec: execSearchKnowledgeBase, label: '📚 知识库检索' },
  get_weather_forecast: { exec: execGetWeather, label: '🌦️ 气象 API' },
  get_current_time: { exec: execGetTime, label: '🕐 时间 API' },
  web_search: { exec: execWebSearch, label: '🔎 联网搜索' },
};

/** 执行一次工具调用，永不 throw（错误作为结果返回给 LLM 处理） */
export async function executeTool(name, args) {
  const tool = TOOL_REGISTRY[name];
  if (!tool) return { error: `未知工具: ${name}` };
  try {
    return await tool.exec(args || {});
  } catch (e) {
    return { error: `工具执行失败: ${String(e.message || e)}` };
  }
}
