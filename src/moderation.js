/**
 * 气象预报解读助手 · 输入内容分类与敏感拦截
 *
 * 在任何处理（本地检索 / LLM 调用）之前运行的前置过滤器：
 * 命中敏感类别的问题直接礼貌拒答，不进入后续管线。
 * LLM 系统提示词中另有第二道拒答约束（见 llm-agent.js）。
 *
 * 设计取向：
 * - 词表按类别组织，只收具体、无歧义的敏感词，避免误伤正常气象问题
 *   （例如不收"政府/国家"——"政府发布的暴雨预警"是正常问题；
 *     不收单字"台"——避免误伤"台风"）。
 * - 命中即拦，宁可词表保守也不做模糊匹配，保证可预期、可测试。
 */

const CATEGORIES = [
  {
    id: 'politics',
    name: '政治敏感',
    words: [
      '政治', '政党', '共产党', '国民党', '民进党', '政权', '政变', '政体',
      '国家主席', '国家领导人', '党和国家', '总书记', '总统', '首相', '选举', '大选',
      '示威', '游行', '抗议', '暴动', '革命', '推翻',
      '六四', '天安门事件', '法轮功', '台独', '港独', '疆独', '藏独',
      '独立公投', '民主运动', '异见人士', '维权人士', '集中营', '人权问题',
      '意识形态', '言论审查', '翻墙',
    ],
  },
  {
    id: 'porn',
    name: '色情低俗',
    words: [
      '色情', '黄片', '黄色网站', '成人网站', 'a片', 'av女优', '裸照', '裸聊',
      '性爱', '做爱', '约炮', '一夜情', '援交', '卖淫', '嫖娼', '情色',
    ],
  },
  {
    id: 'violence_illegal',
    name: '暴力违法',
    words: [
      '炸弹', '爆炸物', '制作炸药', '枪支', '买枪', '弹药', '军火',
      '毒品', '吸毒', '制毒', '贩毒', '大麻', '冰毒', '海洛因', '摇头丸',
      '杀人', '雇凶', '自杀方法', '自残', '投毒', '绑架',
      '黑客攻击', '入侵系统', '木马病毒', '盗号', '撞库',
    ],
  },
  {
    id: 'gambling_fraud',
    name: '赌博诈骗',
    words: [
      '赌博', '赌球', '赌场', '博彩', '六合彩', '时时彩', '网赌',
      '洗钱', '诈骗话术', '电信诈骗', '传销', '刷单兼职', '套现',
    ],
  },
];

/**
 * 对用户输入分类
 * @returns {{blocked: boolean, category: string|null, categoryId: string|null, word: string|null}}
 */
export function moderateQuery(text) {
  const t = (text || '').toLowerCase().replace(/\s+/g, '');
  for (const cat of CATEGORIES) {
    for (const w of cat.words) {
      if (t.includes(w.toLowerCase())) {
        return { blocked: true, category: cat.name, categoryId: cat.id, word: w };
      }
    }
  }
  return { blocked: false, category: null, categoryId: null, word: null };
}

/** 拒答文案（不复述用户的敏感内容，不说教，礼貌引导回主题） */
export function refusalMessage(category) {
  return {
    conclusion: `这个问题涉及${category}内容，超出了我的服务范围，无法回答。`,
    advice: '我专注于天气预报、预警信号、气象指标和 AI 气象模型的解读，也可以帮你查询实时天气。欢迎问我这些话题。',
  };
}
