/**
 * 气象预报解读助手 · 核心引擎（纯逻辑层，浏览器与 Node 均可运行）
 *
 * 管道：用户输入
 *   → 意图识别（实时天气 / 知识问答 / 元问题 / 库外）
 *   → 混合检索（关键词加权 + 字符 bigram 相似度 + 多轮上下文加权）
 *   → 置信度分档（high / mid / low）
 *   → 结构化应答（结论-解释-影响-建议 + 来源引用 + 安全提醒 + 追问推荐）
 *
 * 设计原则（对应评分维度"Agent 可控性"）：
 * - 专业回答只来自知识库条目，低置信度时明确拒答，绝不编造标准或阈值。
 * - 实时天气回答只基于 API 返回的数值，解读规则显式写在代码中，可审计。
 */

import { KB, SOURCES, WEATHER_CODE_MAP } from './kb.js';

/* ============ 文本工具 ============ */

const STOPWORDS = new Set([
  '的', '了', '吗', '呢', '啊', '呀', '吧', '是', '什么', '怎么', '如何', '请问',
  '一下', '这个', '那个', '有', '和', '与', '及', '或', '在', '我', '你', '他',
  'the', 'a', 'is', 'what', 'how', 'to', 'of',
]);

/** 归一化：小写、去标点 */
export function normalize(text) {
  return (text || '')
    .toLowerCase()
    .replace(/[，。？！；：""''、,.?!;:'"()（）\[\]【】\s]+/g, ' ')
    .trim();
}

/** 提取查询词元：连续中文按 2-gram 切分 + 英文/数字单词 */
export function tokenize(text) {
  const norm = normalize(text);
  const tokens = new Set();
  const words = norm.split(' ').filter(Boolean);
  for (const w of words) {
    if (/^[a-z0-9_%.-]+$/.test(w)) {
      if (!STOPWORDS.has(w)) tokens.add(w);
      continue;
    }
    // 中文串：整串 + 2-gram
    const clean = w.replace(/[a-z0-9_%.-]+/g, '');
    if (clean.length >= 2 && !STOPWORDS.has(clean)) tokens.add(clean);
    for (let i = 0; i < clean.length - 1; i++) {
      const bi = clean.slice(i, i + 2);
      if (!STOPWORDS.has(bi)) tokens.add(bi);
    }
    // 中英混排里的英文片段
    const engs = w.match(/[a-z0-9_%.-]{2,}/g) || [];
    engs.forEach((e) => !STOPWORDS.has(e) && tokens.add(e));
  }
  return tokens;
}

/** 字符 bigram Dice 相似度（0-1），用于模糊兜底 */
export function diceSimilarity(a, b) {
  const bigrams = (s) => {
    const n = normalize(s).replace(/ /g, '');
    const set = new Map();
    for (let i = 0; i < n.length - 1; i++) {
      const bg = n.slice(i, i + 2);
      set.set(bg, (set.get(bg) || 0) + 1);
    }
    return set;
  };
  const A = bigrams(a); const B = bigrams(b);
  if (A.size === 0 || B.size === 0) return 0;
  let overlap = 0;
  for (const [bg, cnt] of A) if (B.has(bg)) overlap += Math.min(cnt, B.get(bg));
  let sizeA = 0, sizeB = 0;
  for (const c of A.values()) sizeA += c;
  for (const c of B.values()) sizeB += c;
  return (2 * overlap) / (sizeA + sizeB);
}

/* ============ 意图识别 ============ */

export const INTENT = {
  REALTIME: 'realtime',   // 需要调用实时天气 API
  KNOWLEDGE: 'knowledge', // 知识库问答
  GREETING: 'greeting',   // 寒暄
};

const REALTIME_PATTERNS = [
  /现在.*(天气|气温|温度|下雨|风|适合)/,
  /(今天|明天|后天|今晚|周末|上午|下午|晚上).{0,12}(天气|下雨|气温|温度|适合|风|预报)/,
  /(天气|预报).{0,8}(怎么样|如何|咋样)/,
  /查.{0,6}(天气|预报)/,
  /(适合|能不能|可以).{0,10}(户外|出门|飞|作业|运动|跑步|活动|晾晒)/,
];

const GREETING_PATTERNS = [
  /^(你好|您好|hi|hello|嗨|哈喽|早上好|下午好|晚上好|在吗|在不在)[!！~。.?？]*$/i,
  /^(谢谢|感谢|多谢|thanks|thank you|辛苦了)[!！~。.?？]*$/i,
  /^(再见|拜拜|bye)[!！~。.?？]*$/i,
];

/** 常见城市名（用于实时天气地点抽取的快速匹配；未命中时整句交给 Geocoding） */
const CITY_HINTS = [
  '北京', '上海', '广州', '深圳', '杭州', '南京', '成都', '重庆', '武汉', '西安',
  '天津', '苏州', '长沙', '郑州', '青岛', '大连', '厦门', '福州', '合肥', '昆明',
  '南宁', '贵阳', '海口', '三亚', '兰州', '西宁', '银川', '乌鲁木齐', '拉萨', '哈尔滨',
  '长春', '沈阳', '石家庄', '太原', '呼和浩特', '济南', '南昌', '香港', '澳门', '台北',
  '珠海', '东莞', '佛山', '中山', '惠州', '汕头', '湛江', '宁波', '温州', '无锡',
];

export function detectIntent(text) {
  const t = text.trim();
  if (GREETING_PATTERNS.some((p) => p.test(t))) return INTENT.GREETING;
  // "什么是/怎么理解"类知识问法优先于实时
  const knowledgeCue = /(是什么|什么意思|什么区别|区别|为什么|怎么理解|如何理解|解释|科普|原理|标准是|分几级|指南|论文|模型)/.test(t);
  const realtimeCue = REALTIME_PATTERNS.some((p) => p.test(t));
  if (realtimeCue && !knowledgeCue) return INTENT.REALTIME;
  return INTENT.KNOWLEDGE;
}

/** 从实时天气问题中抽取地点（返回 null 表示需要追问） */
export function extractLocation(text) {
  for (const city of CITY_HINTS) {
    if (text.includes(city)) return city;
  }
  // "在XX" / "XX的天气" 模式
  const m = text.match(/(?:在|去)([\u4e00-\u9fa5]{2,6})(?:的|市|区|县)?(?:天气|下雨|气温|适不适合|适合)?/)
    || text.match(/([\u4e00-\u9fa5]{2,6})(?:市|区|县)?的?(?:天气|气温|预报)/);
  if (m && m[1] && !/(今天|明天|后天|现在|上午|下午|晚上|周末|天气|气温|户外|哪里|什么)/.test(m[1])) {
    return m[1];
  }
  return null;
}

/* ============ 检索 ============ */

/**
 * 混合检索：
 * score = 关键词命中加权(每个命中关键词按长度加权) + 标题 Dice 相似度 * 6 + 上下文延续加权
 */
export function retrieve(query, { contextEntryIds = [], topK = 3 } = {}) {
  const qNorm = normalize(query);
  const qTokens = tokenize(query);

  const scored = KB.map((entry) => {
    let score = 0;
    const matched = [];
    for (const kw of entry.keywords) {
      const kwNorm = normalize(kw);
      if (!kwNorm) continue;
      if (qNorm.includes(kwNorm)) {
        // 直接子串命中：按关键词长度加权，长词更具区分度
        score += Math.min(kwNorm.replace(/ /g, '').length, 8) * 2;
        matched.push(kw);
      } else if (qTokens.has(kwNorm)) {
        score += 3;
        matched.push(kw);
      }
    }
    // 标题模糊相似度兜底
    const sim = diceSimilarity(query, entry.title);
    score += sim * 6;
    // 多轮上下文：上一轮命中的条目及其追问关联条目轻微加权
    if (contextEntryIds.includes(entry.id)) score += 1.5;
    return { entry, score, matched, sim };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, topK).filter((s) => s.score > 0);
}

/** 置信度分档：决定回答策略 */
export function confidenceOf(results) {
  if (!results.length) return 'low';
  const top = results[0];
  const second = results[1];
  const margin = second ? top.score - second.score : top.score;
  if (top.score >= 10 && (top.matched.length >= 2 || top.sim > 0.45)) return 'high';
  if (top.score >= 10 && margin >= 2) return 'high';
  if (top.score >= 5) return 'mid';
  return 'low';
}

/* ============ 应答组装 ============ */

function renderSources(sourceIds) {
  return sourceIds.map((id) => ({ id, ...SOURCES[id] }));
}

export function buildKnowledgeAnswer(query, context) {
  const results = retrieve(query, { contextEntryIds: context.recentEntryIds });
  const confidence = confidenceOf(results);

  if (confidence === 'low') {
    return {
      type: 'refusal',
      confidence,
      html: null,
      structured: {
        conclusion: '这个问题超出了我当前知识库的覆盖范围，为了不误导你，我不做没有依据的回答。',
        explain: '我的知识库覆盖六大主题：气象指标解读、预报产品与不确定性、预警与影响预报（WMO 指南）、AI 气象模型（GraphCast / Pangu-Weather）、预报数据与 API、气象服务沟通表达。',
        advice: '你可以换个问法试试，或从左侧推荐问题中选择；如果需要具体气象标准，建议查询当地气象部门官方发布。',
      },
      sources: [],
      safety: false,
      followups: ['你是谁？你能做什么？', '降水概率 70% 是什么意思？', '什么是影响预报？'],
      entryId: null,
      candidates: results.map((r) => ({ id: r.entry.id, title: r.entry.title, score: +r.score.toFixed(1) })),
    };
  }

  const top = results[0].entry;
  const answer = { ...top.answer };

  // mid 置信度：附加"我理解你在问 X"的确认语，并给出候选
  const clarify = confidence === 'mid'
    ? `我理解你想问的是「${top.title}」，以下按这个问题回答。如果理解偏了，请换个说法告诉我。`
    : null;

  return {
    type: 'knowledge',
    confidence,
    clarify,
    structured: answer,
    sources: renderSources(top.sources),
    safety: top.safety,
    followups: top.followups,
    entryId: top.id,
    category: top.category,
    title: top.title,
    candidates: results.slice(1).map((r) => ({ id: r.entry.id, title: r.entry.title })),
  };
}

export function buildGreetingAnswer() {
  return {
    type: 'greeting',
    confidence: 'high',
    structured: {
      conclusion: '你好！我是气象预报解读助手，可以帮你解读天气预报、预警信号、气象指标和 AI 气象预报模型，也能实时查询并解读任意城市的天气。',
      advice: '试试问我："降水概率 70% 是什么意思？"、"GraphCast 是什么？"，或者"现在深圳的天气适合户外活动吗？"',
    },
    sources: [],
    safety: false,
    followups: ['降水概率 70% 是什么意思？', '什么是影响预报？', '现在深圳的天气怎么样？'],
    entryId: 'meta-who',
  };
}

/* ============ 实时天气解读 ============ */

const OM_GEO = 'https://geocoding-api.open-meteo.com/v1/search';
const OM_FORECAST = 'https://api.open-meteo.com/v1/forecast';

export async function fetchWeather(place, fetchImpl = globalThis.fetch) {
  const geoUrl = `${OM_GEO}?name=${encodeURIComponent(place)}&count=1&language=zh&format=json`;
  const geoRes = await fetchImpl(geoUrl);
  if (!geoRes.ok) throw new Error(`地名解析服务不可用（HTTP ${geoRes.status}）`);
  const geo = await geoRes.json();
  if (!geo.results || !geo.results.length) return { notFound: true, place };
  const loc = geo.results[0];

  const params = new URLSearchParams({
    latitude: loc.latitude, longitude: loc.longitude,
    hourly: 'temperature_2m,relative_humidity_2m,precipitation_probability,precipitation,weather_code,wind_speed_10m,wind_gusts_10m,visibility',
    current: 'temperature_2m,relative_humidity_2m,weather_code,wind_speed_10m,wind_gusts_10m,precipitation',
    forecast_days: '2',
    timezone: loc.timezone || 'auto',
  });
  const wxRes = await fetchImpl(`${OM_FORECAST}?${params}`);
  if (!wxRes.ok) throw new Error(`天气预报服务不可用（HTTP ${wxRes.status}）`);
  const wx = await wxRes.json();
  return { notFound: false, place, loc, wx };
}

/** 把 API 数值翻译为解读（规则显式、可审计） */
export function interpretWeather(data) {
  const { loc, wx } = data;
  const cur = wx.current;
  const codeInfo = WEATHER_CODE_MAP[cur.weather_code] || { text: `编码${cur.weather_code}`, risk: 1 };

  // 取未来 12 小时逐小时数据
  const hourly = wx.hourly;
  const nowIdx = hourly.time.findIndex((t) => new Date(t) >= new Date(cur.time));
  const startIdx = Math.max(nowIdx, 0);
  const rows = [];
  for (let i = startIdx; i < Math.min(startIdx + 12, hourly.time.length); i++) {
    rows.push({
      time: hourly.time[i].slice(11, 16),
      temp: hourly.temperature_2m[i],
      pop: hourly.precipitation_probability?.[i] ?? null,
      precip: hourly.precipitation[i],
      code: hourly.weather_code[i],
      wind: hourly.wind_speed_10m[i],
      gust: hourly.wind_gusts_10m[i],
      vis: hourly.visibility?.[i] ?? null,
    });
  }

  // 风险识别（阈值与 kb.js 条目一致，来源见 api-drone / ind-* 条目）
  const risks = [];
  const maxGust = Math.max(...rows.map((r) => r.gust ?? 0));
  const maxPop = Math.max(...rows.map((r) => r.pop ?? 0));
  const totalPrecip = rows.reduce((s, r) => s + (r.precip || 0), 0);
  const minVis = Math.min(...rows.map((r) => (r.vis == null ? Infinity : r.vis)));
  const hasThunder = rows.some((r) => r.code >= 95);
  const rainHours = rows.filter((r) => (r.pop ?? 0) >= 60).map((r) => r.time);

  if (hasThunder) risks.push({ level: 'high', text: '未来 12 小时内有雷暴信号（weather_code ≥ 95），露天活动和低空飞行应规避雷暴时段' });
  if (maxGust >= 39) risks.push({ level: 'high', text: `最大阵风约 ${Math.round(maxGust)} km/h（≈${(maxGust / 3.6).toFixed(1)} m/s，约 ${gustLevel(maxGust)} 级），高空作业和无人机飞行风险高` });
  else if (maxGust >= 29) risks.push({ level: 'mid', text: `最大阵风约 ${Math.round(maxGust)} km/h（≈${(maxGust / 3.6).toFixed(1)} m/s，约 ${gustLevel(maxGust)} 级），轻型无人机接近抗风上限` });
  if (maxPop >= 60) risks.push({ level: 'mid', text: `降水概率峰值 ${maxPop}%（${rainHours.slice(0, 4).join('、')} 等时段），户外安排建议准备 B 方案` });
  else if (maxPop >= 30) risks.push({ level: 'low', text: `降水概率最高 ${maxPop}%，有零星降水可能` });
  if (totalPrecip >= 10) risks.push({ level: 'mid', text: `未来 12 小时累计降水约 ${totalPrecip.toFixed(1)} mm，达到中雨量级，注意积水` });
  if (minVis !== Infinity && minVis < 1000) risks.push({ level: 'high', text: `最低能见度约 ${(minVis / 1000).toFixed(1)} km，达到"雾"级别，驾车和目视飞行受影响` });
  else if (minVis !== Infinity && minVis < 3000) risks.push({ level: 'low', text: `最低能见度约 ${(minVis / 1000).toFixed(1)} km，轻度受限` });

  const riskLevel = risks.some((r) => r.level === 'high') ? '较高'
    : risks.some((r) => r.level === 'mid') ? '中等'
    : '较低';

  return {
    placeName: `${loc.name}${loc.admin1 && loc.admin1 !== loc.name ? `（${loc.admin1}）` : ''}`,
    current: {
      text: codeInfo.text,
      temp: cur.temperature_2m,
      humidity: cur.relative_humidity_2m,
      wind: cur.wind_speed_10m,
      gust: cur.wind_gusts_10m,
      time: cur.time,
    },
    rows, risks, riskLevel,
    summary: {
      maxGust, maxPop, totalPrecip,
      minVis: minVis === Infinity ? null : minVis,
      hasThunder,
    },
  };
}

/** km/h → 蒲福风级（近似） */
export function gustLevel(kmh) {
  const bounds = [1, 6, 12, 20, 29, 39, 50, 62, 75, 89, 103, 118];
  for (let i = 0; i < bounds.length; i++) if (kmh < bounds[i]) return i;
  return 12;
}

/* ============ 多轮上下文管理 ============ */

export function createContext() {
  return {
    turns: [],            // { role, text, entryId }
    recentEntryIds: [],   // 最近命中的知识条目（含追问关联），用于检索加权
    lastPlace: null,      // 最近查询的地点，支持"那明天呢"式追问
  };
}

export function updateContext(ctx, { userText, answer }) {
  ctx.turns.push({ role: 'user', text: userText });
  ctx.turns.push({ role: 'bot', entryId: answer.entryId || null, type: answer.type });
  if (answer.entryId) {
    const entry = KB.find((e) => e.id === answer.entryId);
    const related = entry
      ? KB.filter((e) => entry.followups.includes(e.title)).map((e) => e.id)
      : [];
    ctx.recentEntryIds = [answer.entryId, ...related].slice(0, 6);
  }
  if (answer.place) ctx.lastPlace = answer.place;
  if (ctx.turns.length > 24) ctx.turns = ctx.turns.slice(-24);
  return ctx;
}

/* ============ LLM 可选增强（仅润色，不新增事实） ============ */

export async function polishWithLLM(answerPayload, userQuery, llmConfig, fetchImpl = globalThis.fetch) {
  const { base, key, model } = llmConfig;
  const kbText = JSON.stringify(answerPayload.structured, null, 2);
  const srcText = answerPayload.sources.map((s) => s.name).join('、');
  const res = await fetchImpl(`${base.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model,
      temperature: 0.3,
      messages: [
        {
          role: 'system',
          content: '你是气象预报解读助手的语言润色器。你只能基于提供的知识库片段改写措辞，使其更贴合用户的具体问法。严禁新增任何知识库片段中没有的事实、数字、标准或阈值。保持"结论/解释/影响/建议"的结构，用简体中文。',
        },
        {
          role: 'user',
          content: `用户问题：${userQuery}\n\n知识库片段（唯一事实来源）：\n${kbText}\n\n来源：${srcText}\n\n请基于以上片段，输出针对该问题的回答，JSON 格式：{"conclusion":"...","explain":"...","impact":"...","advice":"..."}`,
        },
      ],
      response_format: { type: 'json_object' },
    }),
  });
  if (!res.ok) throw new Error(`LLM 接口错误（HTTP ${res.status}）`);
  const json = await res.json();
  const content = json.choices?.[0]?.message?.content;
  const parsed = JSON.parse(content);
  return { ...answerPayload, structured: { ...answerPayload.structured, ...parsed }, llmPolished: true };
}
