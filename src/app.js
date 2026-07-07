/**
 * 气象预报解读助手 · UI 层
 * 负责：消息渲染、推荐问题、实时天气卡片、设置（可选 LLM）、多轮上下文串联
 */

import { KB } from './kb.js';
import {
  detectIntent, INTENT, extractLocation,
  buildKnowledgeAnswer, buildGreetingAnswer,
  fetchWeather, interpretWeather, gustLevel,
  createContext, updateContext, polishWithLLM,
} from './engine.js';

/* ---------- 状态 ---------- */
const ctx = createContext();
const els = {
  messages: document.getElementById('messages'),
  input: document.getElementById('input'),
  form: document.getElementById('composerForm'),
  btnSend: document.getElementById('btnSend'),
  suggestNav: document.getElementById('suggestNav'),
  quickChips: document.getElementById('quickChips'),
  kbStats: document.getElementById('kbStats'),
  btnClear: document.getElementById('btnClear'),
  btnSettings: document.getElementById('btnSettings'),
  settingsDialog: document.getElementById('settingsDialog'),
  statusDot: document.getElementById('statusDot'),
  headerMode: document.getElementById('headerMode'),
  sidebar: document.getElementById('sidebar'),
  btnToggleSidebar: document.getElementById('btnToggleSidebar'),
};

function getLLMConfig() {
  try {
    const raw = localStorage.getItem('wia_llm');
    if (!raw) return null;
    const cfg = JSON.parse(raw);
    return cfg.base && cfg.key && cfg.model ? cfg : null;
  } catch { return null; }
}

/* ---------- 工具 ---------- */
function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function scrollBottom() {
  els.messages.scrollTop = els.messages.scrollHeight;
}

function addMsg(role, html) {
  const div = document.createElement('div');
  div.className = `msg ${role}`;
  div.innerHTML = `
    <div class="avatar">${role === 'user' ? '🧑' : '🌦️'}</div>
    <div class="bubble">${html}</div>`;
  els.messages.appendChild(div);
  scrollBottom();
  return div;
}

function addTyping() {
  return addMsg('bot', '<div class="typing"><span></span><span></span><span></span></div>');
}

/* ---------- 结构化回答渲染 ---------- */
const SECTION_META = [
  ['conclusion', '📌 结论'],
  ['explain', '💡 解释'],
  ['impact', '🎯 影响'],
  ['advice', '✅ 建议'],
];

const CONF_LABEL = { high: '知识库直接命中', mid: '近似匹配', low: '未命中' };

function renderAnswer(ans) {
  let html = '';
  if (ans.clarify) html += `<p style="color:var(--text-dim);font-size:13px;">🔍 ${esc(ans.clarify)}</p>`;

  for (const [key, label] of SECTION_META) {
    const val = ans.structured[key];
    if (!val) continue;
    html += `<h4>${label}${key === 'conclusion' && ans.type !== 'greeting' ? confBadge(ans.confidence) : ''}</h4><p>${esc(val)}</p>`;
  }

  if (ans.safety) {
    html += `<div class="safety-note">⚠️ 涉及安全或作业决策时，请以当地气象部门发布的最新官方预报和预警为准。</div>`;
  }

  if (ans.sources && ans.sources.length) {
    html += `<div class="sources">📚 依据来源：${ans.sources.map((s) => `<span class="src-tag" title="${esc(s.file)}">${esc(s.name)}</span>`).join('')}</div>`;
  }

  if (ans.llmPolished) {
    html += `<div class="sources" style="border-top:none;padding-top:0;">✨ 已由 LLM 基于知识库片段润色（未新增事实）</div>`;
  }

  if (ans.followups && ans.followups.length) {
    html += `<div class="followups">${ans.followups.map((f) => `<button class="followup-chip" data-q="${esc(f)}">${esc(f)}</button>`).join('')}</div>`;
  }
  return html;
}

function confBadge(conf) {
  return `<span class="confidence ${conf}">${CONF_LABEL[conf] || conf}</span>`;
}

/* ---------- 实时天气卡片渲染 ---------- */
function renderWeatherCard(interp, place) {
  const c = interp.current;
  const riskColor = interp.riskLevel === '较高' ? 'low' : interp.riskLevel === '中等' ? 'mid' : 'high';
  let html = `<h4>📌 结论</h4>
    <p><strong>${esc(interp.placeName)}</strong> 当前 ${esc(c.text)}，气温 ${c.temp}℃，湿度 ${c.humidity}%，风速 ${c.wind} km/h（阵风 ${c.gust} km/h，约 ${gustLevel(c.gust)} 级）。未来 12 小时综合天气风险：<span class="confidence ${riskColor}">${interp.riskLevel}</span></p>`;

  if (interp.risks.length) {
    html += `<h4>🎯 风险识别</h4><ul>${interp.risks.map((r) => `<li>${r.level === 'high' ? '🔴' : r.level === 'mid' ? '🟡' : '🟢'} ${esc(r.text)}</li>`).join('')}</ul>`;
  } else {
    html += `<h4>🎯 风险识别</h4><p>🟢 未来 12 小时各项指标均在常规范围内，无明显天气风险信号。</p>`;
  }

  // 逐小时表（取 8 行避免过长）
  const rows = interp.rows.slice(0, 8);
  html += `<h4>💡 逐小时依据（未来 ${rows.length} 小时）</h4>
  <table><tr><th>时间</th><th>气温℃</th><th>降水概率</th><th>降水mm</th><th>阵风km/h</th></tr>
  ${rows.map((r) => `<tr><td>${r.time}</td><td>${r.temp}</td><td>${r.pop ?? '—'}%</td><td>${r.precip}</td><td>${r.gust}</td></tr>`).join('')}
  </table>`;

  html += `<h4>✅ 建议</h4><p>${adviceForRisk(interp)}</p>`;
  html += `<div class="safety-note">⚠️ 以上为 Open-Meteo 模式预报的自动解读，仅供参考。涉及安全、作业、出行的决策，请以当地气象部门最新官方预报和预警为准。</div>`;
  html += `<div class="sources">📚 数据来源：<span class="src-tag">Open-Meteo Forecast API（实时调用）</span><span class="src-tag">解读规则依据知识库阈值条目</span></div>`;
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

/* ---------- 主流程 ---------- */
let busy = false;

async function handleUserInput(text) {
  const query = text.trim();
  if (!query || busy) return;
  busy = true;
  els.btnSend.disabled = true;

  addMsg('user', esc(query));
  const typing = addTyping();

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
          html = renderWeatherCard(interp, place);
        }
      }
    } else {
      answerPayload = buildKnowledgeAnswer(query, ctx);
      // 可选 LLM 润色（仅对知识命中生效；失败静默回退本地答案）
      const llm = getLLMConfig();
      if (llm && answerPayload.type === 'knowledge') {
        try {
          answerPayload = await polishWithLLM(answerPayload, query, llm);
        } catch (e) {
          console.warn('LLM 润色失败，回退本地引擎：', e.message);
        }
      }
      html = renderAnswer(answerPayload);
    }

    typing.querySelector('.bubble').innerHTML = html;
    updateContext(ctx, { userText: query, answer: answerPayload });
  } catch (err) {
    typing.querySelector('.bubble').innerHTML = `
      <h4>📌 出错了</h4>
      <p>${esc(err.message || '未知错误')}</p>
      <p style="color:var(--text-dim);font-size:13px;">实时天气功能需要联网；知识问答不受影响，可继续提问。</p>`;
  } finally {
    busy = false;
    els.btnSend.disabled = false;
    scrollBottom();
  }
}

/* ---------- 初始化：侧边栏推荐问题 ---------- */
function initSidebar() {
  // 知识库统计
  const cats = new Set(KB.map((e) => e.category));
  const srcCount = new Set(KB.flatMap((e) => e.sources)).size;
  els.kbStats.innerHTML = `
    <div class="kb-stat"><b>${KB.length}</b><span>知识条目</span></div>
    <div class="kb-stat"><b>${cats.size}</b><span>主题分类</span></div>
    <div class="kb-stat"><b>${srcCount}</b><span>依据来源</span></div>`;

  // 按分类分组推荐问题（每类取前 3）
  const groups = {};
  for (const e of KB) {
    if (e.category === '关于助手') continue;
    (groups[e.category] ||= []).push(e);
  }
  els.suggestNav.innerHTML = Object.entries(groups).map(([cat, entries]) => `
    <div class="suggest-group">
      <h3>${esc(cat)}</h3>
      ${entries.slice(0, 3).map((e) => `<button class="suggest-item" data-q="${esc(e.title)}">${esc(e.title)}</button>`).join('')}
    </div>`).join('');

  // 快捷chips
  const quicks = [
    '降水概率 70% 是什么意思？',
    'GraphCast 是什么？',
    '现在深圳的天气适合户外活动吗？',
    '橙色预警要停工吗？',
  ];
  els.quickChips.innerHTML = quicks.map((q) => `<button class="followup-chip" data-q="${esc(q)}">${esc(q)}</button>`).join('');
}

function welcome() {
  const ans = buildGreetingAnswer();
  ans.structured = {
    conclusion: '你好，我是气象预报解读助手 🌦️',
    explain: '我的知识库基于 WMO《多灾种影响预报与预警指南》、GraphCast / Pangu-Weather 论文和 Open-Meteo API 文档构建，覆盖气象指标解读、预报产品、预警与影响预报、AI 气象模型、数据接口和服务沟通六大主题。每条回答都会标注依据来源；知识库没有依据时我会直接说明，不编造答案。',
    impact: '我还能实时查询任意城市的天气预报，并按知识库中的阈值规则自动解读风险。',
    advice: '从左侧推荐问题开始，或直接输入你的问题。',
  };
  addMsg('bot', renderAnswer(ans));
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
  els.input.style.height = Math.min(els.input.scrollHeight, 140) + 'px';
});

// 事件委托：推荐问题 / 追问 chips
document.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-q]');
  if (btn) {
    handleUserInput(btn.dataset.q);
    els.sidebar.classList.remove('open');
  }
});

els.btnClear.addEventListener('click', () => {
  els.messages.innerHTML = '';
  ctx.turns = [];
  ctx.recentEntryIds = [];
  ctx.lastPlace = null;
  welcome();
});

els.btnToggleSidebar?.addEventListener('click', () => els.sidebar.classList.toggle('open'));

// 设置弹窗
els.btnSettings.addEventListener('click', () => {
  const cfg = getLLMConfig() || {};
  document.getElementById('llmBase').value = cfg.base || '';
  document.getElementById('llmKey').value = cfg.key || '';
  document.getElementById('llmModel').value = cfg.model || '';
  els.settingsDialog.showModal();
});

document.getElementById('btnSaveSettings').addEventListener('click', () => {
  const base = document.getElementById('llmBase').value.trim();
  const key = document.getElementById('llmKey').value.trim();
  const model = document.getElementById('llmModel').value.trim();
  if (base && key && model) {
    localStorage.setItem('wia_llm', JSON.stringify({ base, key, model }));
  } else {
    localStorage.removeItem('wia_llm');
  }
  refreshMode();
});

function refreshMode() {
  const llm = getLLMConfig();
  if (llm) {
    els.statusDot.classList.add('llm');
    els.headerMode.textContent = `本地知识引擎 + LLM 润色（${llm.model}）`;
  } else {
    els.statusDot.classList.remove('llm');
    els.headerMode.textContent = '本地知识引擎 · 无需联网即可问答';
  }
}

/* ---------- 启动 ---------- */
initSidebar();
refreshMode();
welcome();
