/**
 * 气象预报解读助手 · 自动化评测集
 *
 * 运行：node tests/eval.mjs
 *
 * 覆盖四类断言：
 *  A. 检索准确性：30 个典型问题（含口语化变体）应命中期望知识条目
 *  B. 拒答能力：库外问题必须触发拒答，不得随意命中
 *  C. 意图识别：实时天气 / 知识问答 / 寒暄 分流正确
 *  D. 多轮上下文：追问在上下文加权下命中正确条目
 */

import {
  detectIntent, INTENT, extractLocation,
  buildKnowledgeAnswer, retrieve, confidenceOf,
  createContext, updateContext, gustLevel,
} from '../src/engine.js';
import { KB } from '../src/kb.js';

let pass = 0, fail = 0;
const failures = [];

function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; failures.push(name); console.log(`  ❌ ${name}  ${detail}`); }
}

/* ========== A. 检索准确性 ========== */
console.log('\n[A] 检索准确性（典型问题 + 口语化变体）');
const retrievalCases = [
  // [问题, 期望条目id]
  ['降水概率 70% 是什么意思？是不是一定会下雨？', 'ind-pop'],
  ['下雨概率70%到底会不会下', 'ind-pop'],
  ['降水量多少毫米算暴雨', 'ind-precip-amount'],
  ['10mm的雨算大吗', 'ind-precip-amount'],
  ['阵风和平均风速有什么区别', 'ind-wind-gust'],
  ['预报里的风速和阵风哪个重要', 'ind-wind-gust'],
  ['风力等级和风速怎么换算', 'ind-wind-scale'],
  ['6级风是多少m/s', 'ind-wind-scale'],
  ['能见度1公里以下对交通有什么影响', 'ind-visibility'],
  ['大雾天能见度低有什么危害', 'ind-visibility'],
  ['体感温度和气温为什么不一样', 'ind-temp-feel'],
  ['相对湿度是什么', 'ind-humidity'],
  ['weather_code是什么意思', 'ind-weathercode'],
  ['雾和霾有什么区别', 'ind-fog-haze'],
  ['雷阵雨和阵雨有什么区别', 'ind-thunderstorm'],
  ['紫外线指数多少算强', 'ind-uv'],
  ['未来24小时预报和7天预报哪个更可靠', 'prod-24h-vs-7d'],
  ['一周的天气预报准不准', 'prod-24h-vs-7d'],
  ['为什么不同天气App的预报不一样', 'prod-apps-differ'],
  ['什么是临近预报', 'prod-nowcast'],
  ['什么是集合预报', 'prod-ensemble'],
  ['预报不确定性应该怎么表达才不会误导用户', 'prod-uncertainty'],
  ['天气预报是怎么算出来的', 'prod-nwp'],
  ['什么是影响预报？和普通天气预报有什么区别？', 'warn-ibf'],
  ['预警信号的蓝黄橙红代表什么', 'warn-colors'],
  ['多灾种预警是什么意思', 'warn-multihazard'],
  ['什么是风险矩阵', 'warn-riskmatrix'],
  ['预警信息应该怎么分对象发布', 'warn-audience'],
  ['高温预警的标准是什么', 'warn-highttemp'],
  ['大风预警分几级', 'warn-galewind'],
  ['GraphCast和传统数值天气预报有什么不同', 'ai-graphcast'],
  ['Pangu-Weather这类AI气象模型能解决什么问题', 'ai-pangu'],
  ['盘古气象大模型是干什么的', 'ai-pangu'],
  ['AI会取代传统数值预报吗', 'ai-vs-nwp'],
  ['ERA5再分析数据是什么', 'ai-era5'],
  ['0.25度分辨率是什么概念', 'ai-resolution'],
  ['Open-Meteo API有哪些常用字段', 'api-openmeteo'],
  ['判断户外任务能不能做应该看哪些预报字段', 'api-fields-usage'],
  ['无人机飞行关注哪些气象指标', 'api-drone'],
  ['海上作业浪高多少算危险', 'api-marine'],
  ['预报显示下午有雷阵雨怎么向客户解释', 'comm-thunder-explain'],
  ['预报说有雨却没下客户质疑怎么回应', 'comm-forecast-miss'],
  ['一份好的天气早报应该包含什么', 'comm-daily-briefing'],
  ['你是谁，你能做什么', 'meta-who'],
  ['你的回答依据是什么', 'meta-sources'],
];

for (const [q, expectId] of retrievalCases) {
  const ctx = createContext();
  const ans = buildKnowledgeAnswer(q, ctx);
  check(`"${q}" → ${expectId}`, ans.entryId === expectId,
    `实际: ${ans.entryId} (${ans.confidence})`);
}

/* ========== B. 拒答能力（库外问题） ========== */
console.log('\n[B] 库外问题拒答（不得编造）');
const outOfScopeCases = [
  '帮我写一首关于爱情的诗',
  '2028年世界杯在哪里举办',
  '如何配置Kubernetes集群',
  '推荐几只值得买的股票',
];
for (const q of outOfScopeCases) {
  const ctx = createContext();
  const ans = buildKnowledgeAnswer(q, ctx);
  check(`"${q}" → 拒答`, ans.type === 'refusal',
    `实际命中: ${ans.entryId} (${ans.confidence})`);
}

/* ========== C. 意图识别 ========== */
console.log('\n[C] 意图识别分流');
const intentCases = [
  ['现在深圳的天气怎么样', INTENT.REALTIME],
  ['明天北京适合户外运动吗', INTENT.REALTIME],
  ['今天下午上海会下雨吗', INTENT.REALTIME],
  ['降水概率70%是什么意思', INTENT.KNOWLEDGE],
  ['GraphCast是什么', INTENT.KNOWLEDGE],
  ['影响预报和普通预报的区别', INTENT.KNOWLEDGE],
  ['你好', INTENT.GREETING],
  ['谢谢', INTENT.GREETING],
];
for (const [q, expected] of intentCases) {
  const got = detectIntent(q);
  check(`"${q}" → ${expected}`, got === expected, `实际: ${got}`);
}

/* ========== C2. 地点抽取 ========== */
console.log('\n[C2] 实时天气地点抽取');
const locCases = [
  ['现在深圳的天气怎么样', '深圳'],
  ['明天杭州适合户外活动吗', '杭州'],
  ['今天会下雨吗', null],
];
for (const [q, expected] of locCases) {
  const got = extractLocation(q);
  check(`"${q}" → ${expected === null ? '需追问地点' : expected}`, got === expected, `实际: ${got}`);
}

/* ========== D. 多轮上下文 ========== */
console.log('\n[D] 多轮上下文追问');
{
  const ctx = createContext();
  const a1 = buildKnowledgeAnswer('降水概率70%是什么意思', ctx);
  updateContext(ctx, { userText: '降水概率70%是什么意思', answer: a1 });
  check('第一轮命中 ind-pop', a1.entryId === 'ind-pop', `实际: ${a1.entryId}`);
  check('上下文记录了相关条目', ctx.recentEntryIds.includes('ind-pop'));

  // 模糊追问："那7天的呢" —— 依赖上下文加权命中 prod-24h-vs-7d
  const a2 = buildKnowledgeAnswer('那7天预报可靠吗', ctx);
  check('追问 "那7天预报可靠吗" → prod-24h-vs-7d', a2.entryId === 'prod-24h-vs-7d', `实际: ${a2.entryId}`);
}

/* ========== E. 回答结构完整性 ========== */
console.log('\n[E] 知识条目结构完整性');
{
  let structOk = true, srcOk = true, fuOk = true;
  for (const e of KB) {
    if (!e.answer.conclusion || !e.answer.explain) structOk = false;
    if (!e.sources || !e.sources.length) srcOk = false;
    if (!Array.isArray(e.followups)) fuOk = false;
  }
  check(`全部 ${KB.length} 条条目含"结论+解释"`, structOk);
  check('全部条目标注依据来源', srcOk);
  check('全部条目配置追问推荐', fuOk);
  const safetyCount = KB.filter((e) => e.safety).length;
  check(`安全敏感条目已标记复核提醒（${safetyCount} 条）`, safetyCount >= 8);
}

/* ========== F. 工具函数 ========== */
console.log('\n[F] 工具函数');
check('风级换算：36 km/h ≈ 5 级', gustLevel(36) === 5, `实际: ${gustLevel(36)}`);
check('风级换算：75 km/h ≈ 9 级', gustLevel(75) === 9, `实际: ${gustLevel(75)}`);

/* ========== 汇总 ========== */
console.log('\n' + '='.repeat(50));
console.log(`评测完成：通过 ${pass} / ${pass + fail}（准确率 ${((pass / (pass + fail)) * 100).toFixed(1)}%）`);
if (fail) {
  console.log('未通过项：');
  failures.forEach((f) => console.log(`  - ${f}`));
  process.exit(1);
}
