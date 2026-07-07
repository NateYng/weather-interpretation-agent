/**
 * 气象预报解读助手 · UI 层
 * 负责：消息渲染、Hero 空状态与建议卡片、提问灵感抽屉、
 *       设置（全能模式）、多轮上下文串联
 */

import { KB } from './kb.js';
import {
  detectIntent, INTENT, extractLocation,
  buildKnowledgeAnswer, buildGreetingAnswer,
  fetchWeather, interpretWeather, gustLevel,
  createContext, updateContext,
} from './engine.js';
import { runAgent } from './llm-agent.js';
import { moderateQuery, refusalMessage } from './moderation.js';
import {
  newSessionId, saveSession, getSession,
  deleteSession, clearAllSessions, searchSessions, formatTime,
} from './history.js';

/* ---------- 状态 ---------- */
const ctx = createContext();
const chatHistory = []; // 全能模式的对话历史 [{role:'user'|'assistant', content}]
let sessionId = null;   // 当前会话 id（首条消息时创建）
let sessionCreatedAt = null;

const els = {
  messages: document.getElementById('messages'),
  input: document.getElementById('input'),
  form: document.getElementById('composerForm'),
  btnSend: document.getElementById('btnSend'),
  hero: document.getElementById('hero'),
  heroGreeting: document.getElementById('heroGreeting'),
  heroCards: document.getElementById('heroCards'),
  kbStats: document.getElementById('kbStats'),
  suggestNav: document.getElementById('suggestNav'),
  ideasDrawer: document.getElementById('ideasDrawer'),
  scrim: document.getElementById('scrim'),
  btnIdeas: document.getElementById('btnIdeas'),
  btnCloseIdeas: document.getElementById('btnCloseIdeas'),
  historyDrawer: document.getElementById('historyDrawer'),
  historyList: document.getElementById('historyList'),
  historySearch: document.getElementById('historySearch'),
  btnHistory: document.getElementById('btnHistory'),
  btnCloseHistory: document.getElementById('btnCloseHistory'),
  btnClearHistory: document.getElementById('btnClearHistory'),
  btnClear: document.getElementById('btnClear'),
  statusDot: document.getElementById('statusDot'),
  headerMode: document.getElementById('headerMode'),
};

const BOT_GLYPH = `<img src="assets/avatar.png" alt="气象预报解读助手" />`;

/* 极简线性图标（1.5px 描边，取自手绘感线稿风格，替代 emoji） */
const ICONS = {
  book: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20V4H6.5A2.5 2.5 0 0 0 4 6.5v13Z"/><path d="M4 19.5A2.5 2.5 0 0 0 6.5 22H20v-5"/></svg>`,
  cloud: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M17.5 19a4.5 4.5 0 1 0-.42-8.98 6 6 0 1 0-11.06 3.1A3.5 3.5 0 0 0 7 19h10.5Z"/></svg>`,
  clock: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>`,
  search: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>`,
  chat: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a8 8 0 0 1-8 8H4l2.3-2.9A8 8 0 1 1 21 12Z"/></svg>`,
};

/* 工具名 → 图标（用于回答尾部的工具链标签） */
const TOOL_ICONS = {
  search_knowledge_base: ICONS.book,
  get_weather_forecast: ICONS.cloud,
  get_current_time: ICONS.clock,
  web_search: ICONS.search,
};

/** 内置大模型接口（固定配置，用户无需设置；调用失败自动回退本地知识引擎） */
const LLM_CONFIG = {
  base: 'https://new-api.geekstorm.com.cn/v1',
  key: 'e4FycFzvMyzPnQkJgSHfhvZtVisG7xMepnHjGEZW9dU4qCEh',
  model: 'qwen3.6-flash',
};

const URL_PARAMS = new URLSearchParams(location.search);

function getLLMConfig() {
  // 深链参数 engine=local 可强制使用本地知识引擎（演示/调试用）
  if (URL_PARAMS.get('engine') === 'local') return null;
  return LLM_CONFIG;
}

/* ---------- 工具 ---------- */
function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function scrollBottom() {
  window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
}

function hideHero() {
  els.hero.classList.add('hidden');
}

function addMsg(role, html) {
  hideHero();
  const div = document.createElement('div');
  div.className = `msg ${role}`;
  div.innerHTML = role === 'user'
    ? `<div class="bubble">${html}</div>`
    : `<div class="avatar">${BOT_GLYPH}</div><div class="bubble">${html}</div>`;
  els.messages.appendChild(div);
  scrollBottom();
  return div;
}

function addTyping() {
  return addMsg('bot', '<div class="typing"><span></span><span></span><span></span></div>');
}

/* ---------- 结构化回答渲染 ---------- */
const SECTION_META = [
  ['conclusion', '结论'],
  ['explain', '解释'],
  ['impact', '影响'],
  ['advice', '建议'],
];

const CONF_LABEL = { high: '知识库直接命中', mid: '近似匹配', low: '未命中' };

function renderAnswer(ans) {
  let html = '';
  if (ans.clarify) html += `<p class="status-line">${esc(ans.clarify)}</p>`;

  for (const [key, label] of SECTION_META) {
    const val = ans.structured[key];
    if (!val) continue;
    html += `<h4>${label}${key === 'conclusion' && ans.type !== 'greeting' ? confBadge(ans.confidence) : ''}</h4><p>${esc(val)}</p>`;
  }

  if (ans.safety) {
    html += `<div class="safety-note">涉及安全或作业决策时，请以当地气象部门发布的最新官方预报和预警为准。</div>`;
  }

  if (ans.sources && ans.sources.length) {
    html += `<div class="sources">依据来源 ${ans.sources.map((s) => `<span class="src-tag" title="${esc(s.file)}">${esc(s.name)}</span>`).join('')}</div>`;
  }

  if (ans.followups && ans.followups.length) {
    html += `<div class="followups">${ans.followups.map((f) => `<button class="followup-chip" data-q="${esc(f)}">${esc(f)}</button>`).join('')}</div>`;
  }
  return html;
}

function confBadge(conf) {
  if (!conf || !CONF_LABEL[conf]) return '';
  return `<span class="confidence ${conf}">${CONF_LABEL[conf]}</span>`;
}

/* ---------- 实时天气卡片渲染 ---------- */
function renderWeatherCard(interp) {
  const c = interp.current;
  const riskColor = interp.riskLevel === '较高' ? 'low' : interp.riskLevel === '中等' ? 'mid' : 'high';
  let html = `<h4>结论</h4>
    <p><strong>${esc(interp.placeName)}</strong> 当前 ${esc(c.text)}，气温 ${c.temp}℃，湿度 ${c.humidity}%，风速 ${c.wind} km/h（阵风 ${c.gust} km/h，约 ${gustLevel(c.gust)} 级）。未来 12 小时综合天气风险 <span class="confidence ${riskColor}">${interp.riskLevel}</span></p>`;

  if (interp.risks.length) {
    html += `<h4>风险识别</h4><ul class="risk-list">${interp.risks.map((r) => `<li><span class="risk-dot ${r.level}"></span>${esc(r.text)}</li>`).join('')}</ul>`;
  } else {
    html += `<h4>风险识别</h4><p><span class="risk-dot low"></span>未来 12 小时各项指标均在常规范围内，无明显天气风险信号。</p>`;
  }

  const rows = interp.rows.slice(0, 8);
  html += `<h4>逐小时依据（未来 ${rows.length} 小时）</h4>
  <table><tr><th>时间</th><th>气温℃</th><th>降水概率</th><th>降水mm</th><th>阵风km/h</th></tr>
  ${rows.map((r) => `<tr><td>${r.time}</td><td>${r.temp}</td><td>${r.pop ?? '—'}%</td><td>${r.precip}</td><td>${r.gust}</td></tr>`).join('')}
  </table>`;

  html += `<h4>建议</h4><p>${adviceForRisk(interp)}</p>`;
  html += `<div class="safety-note">以上为 Open-Meteo 模式预报的自动解读，仅供参考。涉及安全、作业、出行的决策，请以当地气象部门最新官方预报和预警为准。</div>`;
  html += `<div class="sources">数据来源 <span class="src-tag">Open-Meteo Forecast API（实时调用）</span><span class="src-tag">解读规则依据知识库阈值条目</span></div>`;
  html += `<div class="followups">
    <button class="followup-chip" data-q="降水概率 70% 是什么意思？">降水概率是什么意思？</button>
    <button class="followup-chip" data-q="阵风和平均风速有什么区别？">阵风和平均风速的区别</button>
    <button class="followup-chip" data-q="判断户外任务应该看哪些预报字段？">户外任务看哪些字段？</button>
  </div>`;
  return html;
}

function adviceForRisk(interp) {
  const parts = [];
  if (interp.summary.hasThunder) parts.push('雷暴时段应停止露天活动和低空飞行，活动前 1–2 小时复核临近预报');
  if (interp.summary.maxPop >= 60) parts.push('降雨概率较高时段建议携带雨具或准备室内 B 方案');
  if (interp.summary.maxGust >= 29) parts.push('大风时段避免高空作业，无人机飞行前实测现场风速');
  if (!parts.length) parts.push('天气条件总体适宜，按计划安排即可，外出前可再次确认最新预报');
  return parts.join('；') + '。';
}

/* ---------- Markdown 轻量渲染（全能模式 LLM 输出用） ---------- */
function renderMarkdown(md) {
  const lines = esc(md).split('\n');
  let html = '';
  let inList = false, inTable = false;
  const closeBlocks = () => {
    if (inList) { html += '</ul>'; inList = false; }
    if (inTable) { html += '</table>'; inTable = false; }
  };
  const inline = (s) => s
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');

  for (const raw of lines) {
    const line = raw.trimEnd();
    if (/^\|.*\|$/.test(line)) {
      if (/^\|[\s:|-]+\|$/.test(line)) continue; // 分隔行
      const cells = line.slice(1, -1).split('|').map((c) => inline(c.trim()));
      if (!inTable) { closeBlocks(); html += '<table>'; inTable = true; html += `<tr>${cells.map((c) => `<th>${c}</th>`).join('')}</tr>`; }
      else html += `<tr>${cells.map((c) => `<td>${c}</td>`).join('')}</tr>`;
      continue;
    }
    if (inTable) { html += '</table>'; inTable = false; }
    const h = line.match(/^(#{1,4})\s+(.*)/);
    if (h) { closeBlocks(); html += `<h4>${inline(h[2])}</h4>`; continue; }
    const li = line.match(/^\s*(?:[-*]|\d+\.)\s+(.*)/);
    if (li) {
      if (!inList) { html += '<ul>'; inList = true; }
      html += `<li>${inline(li[1])}</li>`;
      continue;
    }
    if (inList) { html += '</ul>'; inList = false; }
    if (line.trim()) html += `<p>${inline(line)}</p>`;
  }
  closeBlocks();
  return html;
}

function renderAgentAnswer(content, toolTrace) {
  let html = renderMarkdown(content);
  if (toolTrace.length) {
    html += `<div class="sources">本次调用工具 ${toolTrace.map((t) =>
      `<span class="src-tag tool" title="${esc(JSON.stringify(t.args))}">${TOOL_ICONS[t.name] || ''}${esc(t.label)}${t.ok ? '' : '（失败）'}</span>`).join('')}</div>`;
  } else {
    html += `<div class="sources"><span class="src-tag tool">${ICONS.chat}由大模型直接回答（未调用工具）</span></div>`;
  }
  return html;
}

/* ---------- 会话持久化 ---------- */
let userTextsArr = [];

function persistSession() {
  const msgs = [...els.messages.children].map((div) => ({
    role: div.classList.contains('user') ? 'user' : 'bot',
    html: div.querySelector('.bubble').innerHTML,
  }));
  if (!msgs.length) return;
  if (!sessionId) { sessionId = newSessionId(); sessionCreatedAt = Date.now(); }
  saveSession({
    id: sessionId,
    title: (userTextsArr[0] || '新对话').slice(0, 40),
    createdAt: sessionCreatedAt,
    updatedAt: Date.now(),
    messages: msgs,
    chatHistory: [...chatHistory],
    userTexts: [...userTextsArr],
  });
}

function resetSession() {
  els.messages.innerHTML = '';
  ctx.turns = [];
  ctx.recentEntryIds = [];
  ctx.lastPlace = null;
  chatHistory.length = 0;
  userTextsArr = [];
  sessionId = null;
  sessionCreatedAt = null;
  els.hero.classList.remove('hidden');
  window.scrollTo({ top: 0 });
}

function loadSession(id) {
  const s = getSession(id);
  if (!s) return;
  resetSession();
  for (const m of s.messages) addMsg(m.role, m.html);
  chatHistory.push(...(s.chatHistory || []));
  userTextsArr = [...(s.userTexts || [])];
  sessionId = s.id;
  sessionCreatedAt = s.createdAt;
}

/* ---------- 主流程 ---------- */
let busy = false;

async function handleUserInput(text) {
  const query = text.trim();
  if (!query || busy) return;

  // ===== 前置内容分类：敏感/政治类问题直接拒答，不进入任何后续管线 =====
  const mod = moderateQuery(query);
  if (mod.blocked) {
    addMsg('user', esc(query));
    addMsg('bot', renderAnswer({
      type: 'refusal-sensitive',
      structured: refusalMessage(mod.category),
      sources: [], safety: false,
      followups: ['降水概率 70% 是什么意思？', '现在深圳的天气怎么样？', '什么是影响预报？'],
    }));
    userTextsArr.push(query);
    persistSession();
    return;
  }

  busy = true;
  els.btnSend.disabled = true;
  userTextsArr.push(query);

  addMsg('user', esc(query));
  const typing = addTyping();

  // ===== 全能模式：配置了 LLM 后，任何问题都交给工具调用 Agent =====
  const llm = getLLMConfig();
  if (llm) {
    try {
      chatHistory.push({ role: 'user', content: query });
      const setStatus = (s) => {
        typing.querySelector('.bubble').innerHTML =
          `<div class="typing"><span></span><span></span><span></span></div><p class="status-line">${esc(s)}</p>`;
        scrollBottom();
      };
      const { content, toolTrace } = await runAgent(chatHistory.slice(-12), llm, setStatus);
      chatHistory.push({ role: 'assistant', content });
      typing.querySelector('.bubble').innerHTML = renderAgentAnswer(content, toolTrace);
      updateContext(ctx, { userText: query, answer: { type: 'agent', entryId: null } });
      busy = false;
      els.btnSend.disabled = false;
      persistSession();
      scrollBottom();
      return;
    } catch (err) {
      console.warn('全能模式失败，回退本地引擎：', err);
      chatHistory.pop(); // 移除未成功的这轮
      typing.querySelector('.bubble').innerHTML =
        `<p class="fallback-note">大模型调用失败（${esc(err.message || '未知错误')}），已回退本地知识引擎。</p><div class="typing"><span></span><span></span><span></span></div>`;
      // 继续走下方本地管线
    }
  }

  try {
    const intent = detectIntent(query);
    let answerPayload;
    let html;

    if (intent === INTENT.GREETING) {
      answerPayload = buildGreetingAnswer();
      html = renderAnswer(answerPayload);
    } else if (intent === INTENT.REALTIME) {
      const place = extractLocation(query) || ctx.lastPlace;
      if (!place) {
        answerPayload = {
          type: 'ask-location', entryId: null,
          structured: {
            conclusion: '我可以帮你查询并解读实时天气，但需要先知道地点。',
            advice: '请告诉我城市或地区名称，例如："现在深圳的天气适合户外活动吗？"',
          },
          sources: [], safety: false,
          followups: ['现在深圳的天气怎么样？', '现在北京的天气怎么样？'],
        };
        html = renderAnswer(answerPayload);
      } else {
        const data = await fetchWeather(place);
        if (data.notFound) {
          answerPayload = {
            type: 'geo-fail', entryId: null,
            structured: {
              conclusion: `没有找到「${place}」这个地点，请提供更明确的城市名。`,
              advice: '建议使用地级市或知名区域名称，例如"深圳"、"杭州"、"三亚"。',
            },
            sources: [], safety: false, followups: [],
          };
          html = renderAnswer(answerPayload);
        } else {
          const interp = interpretWeather(data);
          answerPayload = { type: 'realtime', entryId: null, place };
          html = renderWeatherCard(interp);
        }
      }
    } else {
      answerPayload = buildKnowledgeAnswer(query, ctx);
      html = renderAnswer(answerPayload);
    }

    const notice = llm
      ? `<p class="fallback-note">大模型调用失败，以下为本地知识引擎的回答。</p>`
      : '';
    typing.querySelector('.bubble').innerHTML = notice + html;
    updateContext(ctx, { userText: query, answer: answerPayload });
  } catch (err) {
    typing.querySelector('.bubble').innerHTML = `
      <h4>出错了</h4>
      <p>${esc(err.message || '未知错误')}</p>
      <p class="status-line">实时天气功能需要联网；知识问答不受影响，可继续提问。</p>`;
  } finally {
    busy = false;
    els.btnSend.disabled = false;
    persistSession();
    scrollBottom();
  }
}

/* ---------- 初始化：Hero 与提问灵感 ---------- */
const HERO_CARDS = [
  { cat: '指标解读', q: '降水概率 70% 是什么意思？是不是一定会下雨？' },
  { cat: '实时天气', q: '现在深圳的天气适合户外活动吗？' },
  { cat: 'AI 气象模型', q: 'GraphCast 和传统数值天气预报有什么不同？' },
  { cat: '预警知识', q: '气象预警信号的蓝、黄、橙、红分别代表什么？' },
];

function initHero() {
  const hour = new Date().getHours();
  const greet = hour < 6 ? '夜深了。' : hour < 12 ? '早上好。' : hour < 18 ? '下午好。' : '晚上好。';
  els.heroGreeting.textContent = `${greet}把预报，讲成人话。`;

  els.heroCards.innerHTML = HERO_CARDS.map((c) => `
    <button class="hero-card" data-q="${esc(c.q)}">
      <span class="cat">${esc(c.cat)}</span>
      <span class="q">${esc(c.q)}</span>
    </button>`).join('');

  const cats = new Set(KB.map((e) => e.category));
  const srcCount = new Set(KB.flatMap((e) => e.sources)).size;
  els.kbStats.innerHTML = `知识库收录 <b>${KB.length}</b> 个问题单元 · <b>${cats.size}</b> 个主题 · <b>${srcCount}</b> 类可追溯来源 · 库外问题明确拒答`;
}

function initIdeas() {
  const groups = {};
  for (const e of KB) {
    if (e.category === '关于助手') continue;
    (groups[e.category] ||= []).push(e);
  }
  els.suggestNav.innerHTML = Object.entries(groups).map(([cat, entries]) => `
    <div class="suggest-group">
      <h3>${esc(cat)}</h3>
      ${entries.map((e) => `<button class="suggest-item" data-q="${esc(e.title)}">${esc(e.title)}</button>`).join('')}
    </div>`).join('');
}

function setDrawer(drawer, open) {
  drawer.classList.toggle('open', open);
  drawer.setAttribute('aria-hidden', String(!open));
  els.scrim.hidden = !(els.ideasDrawer.classList.contains('open') || els.historyDrawer.classList.contains('open'));
}
function openIdeas(open) {
  if (open) setDrawer(els.historyDrawer, false);
  setDrawer(els.ideasDrawer, open);
}
function openHistory(open) {
  if (open) {
    setDrawer(els.ideasDrawer, false);
    renderHistoryList(els.historySearch.value);
  }
  setDrawer(els.historyDrawer, open);
}

/* ---------- 历史对话列表 ---------- */
const DEL_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>`;

function renderHistoryList(query = '') {
  const sessions = searchSessions(query);
  if (!sessions.length) {
    els.historyList.innerHTML = `<p class="history-empty">${query ? '没有匹配的历史对话' : '暂无历史对话。开始提问后会自动保存在本机。'}</p>`;
    return;
  }
  els.historyList.innerHTML = sessions.map((s) => `
    <div class="history-item${s.id === sessionId ? ' active' : ''}" data-sid="${esc(s.id)}" role="button" tabindex="0">
      <div class="history-main">
        <span class="history-title">${esc(s.title)}</span>
        <span class="history-meta">${formatTime(s.updatedAt)} · ${(s.userTexts || []).length} 次提问</span>
      </div>
      <button class="history-del" data-del="${esc(s.id)}" title="删除该对话" aria-label="删除">${DEL_ICON}</button>
    </div>`).join('');
}

/* ---------- 事件绑定 ---------- */
els.form.addEventListener('submit', (e) => {
  e.preventDefault();
  const v = els.input.value;
  els.input.value = '';
  els.input.style.height = 'auto';
  handleUserInput(v);
});

els.input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    els.form.requestSubmit();
  }
});

els.input.addEventListener('input', () => {
  els.input.style.height = 'auto';
  els.input.style.height = Math.min(els.input.scrollHeight, 160) + 'px';
});

// 事件委托：Hero 卡片 / 推荐问题 / 追问 chips
document.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-q]');
  if (btn) {
    openIdeas(false);
    handleUserInput(btn.dataset.q);
  }
});

els.btnClear.addEventListener('click', () => {
  persistSession();
  resetSession();
});

els.btnIdeas.addEventListener('click', () => openIdeas(true));
els.btnCloseIdeas.addEventListener('click', () => openIdeas(false));
els.btnHistory.addEventListener('click', () => openHistory(true));
els.btnCloseHistory.addEventListener('click', () => openHistory(false));
els.scrim.addEventListener('click', () => { openIdeas(false); openHistory(false); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { openIdeas(false); openHistory(false); } });

// 历史抽屉：搜索 / 载入 / 删除 / 清空
els.historySearch.addEventListener('input', () => renderHistoryList(els.historySearch.value));

els.historyList.addEventListener('click', (e) => {
  const del = e.target.closest('[data-del]');
  if (del) {
    e.stopPropagation();
    deleteSession(del.dataset.del);
    if (del.dataset.del === sessionId) sessionId = null;
    renderHistoryList(els.historySearch.value);
    return;
  }
  const item = e.target.closest('[data-sid]');
  if (item) {
    persistSession();
    loadSession(item.dataset.sid);
    openHistory(false);
  }
});

els.btnClearHistory.addEventListener('click', () => {
  if (confirm('确定清空全部历史对话吗？此操作不可恢复。')) {
    clearAllSessions();
    sessionId = null;
    renderHistoryList('');
  }
});

function refreshMode() {
  els.statusDot.classList.add('llm');
  els.headerMode.textContent = '全能模式';
  els.headerMode.parentElement.title = '内置大模型自主调用知识库 / 气象 / 时间 / 搜索四个工具，可回答任意问题；调用失败自动回退本地知识引擎';
}

/* ---------- 启动 ---------- */
initHero();
initIdeas();
refreshMode();

/* 深链参数：?q=问题 自动提问；?panel=history 打开历史抽屉（&seed=1 注入演示数据） */
(function handleDeepLink() {
  if (URL_PARAMS.get('panel') === 'history') {
    if (URL_PARAMS.get('seed') === '1') {
      const now = Date.now();
      saveSession({ id: 'demo_1', title: '降水概率 70% 是什么意思？是不是一定会下雨？', createdAt: now - 86400000 * 2, updatedAt: now - 86400000 * 2, messages: [], chatHistory: [], userTexts: ['降水概率 70% 是什么意思？', '那7天预报可靠吗'] });
      saveSession({ id: 'demo_2', title: '现在深圳的天气适合户外活动吗？', createdAt: now - 3600000 * 5, updatedAt: now - 3600000 * 5, messages: [], chatHistory: [], userTexts: ['现在深圳的天气适合户外活动吗？'] });
      saveSession({ id: 'demo_3', title: 'GraphCast 和传统数值天气预报有什么不同？', createdAt: now - 600000, updatedAt: now - 600000, messages: [], chatHistory: [], userTexts: ['GraphCast 和传统数值天气预报有什么不同？', 'Pangu-Weather 呢？'] });
    }
    openHistory(true);
  }
  const q = URL_PARAMS.get('q');
  if (q) handleUserInput(q);
})();
