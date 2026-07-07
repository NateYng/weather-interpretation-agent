/**
 * 气象预报解读助手 · 历史对话存储（localStorage，纯本地，不上传）
 *
 * 会话结构：
 * { id, title, createdAt, updatedAt,
 *   messages: [{role:'user'|'bot', html}],   // 用于回放渲染
 *   chatHistory: [{role, content}],           // 用于全能模式续聊上下文
 *   userTexts: [string] }                     // 用于搜索
 */

const KEY = 'wia_sessions';
const MAX_SESSIONS = 50;

function readAll() {
  try {
    return JSON.parse(localStorage.getItem(KEY) || '[]');
  } catch { return []; }
}

function writeAll(sessions) {
  try {
    localStorage.setItem(KEY, JSON.stringify(sessions));
  } catch {
    // 容量超限：丢弃最旧的一半后重试一次
    try {
      localStorage.setItem(KEY, JSON.stringify(sessions.slice(0, Math.ceil(sessions.length / 2))));
    } catch { /* 放弃保存，不影响对话功能 */ }
  }
}

export function newSessionId() {
  return `s_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

/** 列出全部会话（按更新时间倒序） */
export function listSessions() {
  return readAll().sort((a, b) => b.updatedAt - a.updatedAt);
}

/** 新建或更新会话 */
export function saveSession(session) {
  const sessions = readAll();
  const idx = sessions.findIndex((s) => s.id === session.id);
  if (idx >= 0) sessions[idx] = session;
  else sessions.push(session);
  // 按更新时间倒序并截断上限
  sessions.sort((a, b) => b.updatedAt - a.updatedAt);
  writeAll(sessions.slice(0, MAX_SESSIONS));
}

export function getSession(id) {
  return readAll().find((s) => s.id === id) || null;
}

export function deleteSession(id) {
  writeAll(readAll().filter((s) => s.id !== id));
}

export function clearAllSessions() {
  localStorage.removeItem(KEY);
}

/** 按关键词搜索（匹配标题与用户提问文本） */
export function searchSessions(query) {
  const q = (query || '').trim().toLowerCase();
  const all = listSessions();
  if (!q) return all;
  return all.filter((s) =>
    (s.title || '').toLowerCase().includes(q) ||
    (s.userTexts || []).some((t) => t.toLowerCase().includes(q)));
}

/** 格式化时间显示：今天显示时刻，其它显示日期 */
export function formatTime(ts) {
  const d = new Date(ts);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) return d.toTimeString().slice(0, 5);
  const y = d.getFullYear() === now.getFullYear() ? '' : `${d.getFullYear()}/`;
  return `${y}${d.getMonth() + 1}/${d.getDate()}`;
}
