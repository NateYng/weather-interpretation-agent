# 气象预报解读助手

知识问答类 Agent：把天气预报、预警预报、气象指标和 AI 气象预报模型解释成人话，每条回答标注依据来源，支持实时天气查询与解读。

## 特性

- **38 条结构化知识条目**，覆盖 6 大主题：指标解读、预报产品、预警与影响预报（WMO）、AI 气象模型（GraphCast / Pangu-Weather）、数据与 API、服务沟通表达
- **答案可追溯**：每条回答标注来源（WMO 指南 / GraphCast 论文 / Pangu-Weather 论文 / Open-Meteo 文档等）
- **拒答机制**：库外问题明确说明"没有依据"，绝不编造标准和阈值
- **实时天气解读**：调用 Open-Meteo Geocoding + Forecast API，按知识库阈值规则自动识别风险并输出逐小时依据
- **多轮上下文**：追问时按上一轮命中条目加权检索
- **全能模式（默认开启，内置模型）**：内置 OpenAI 兼容接口（qwen3.6-flash），大模型通过 function calling 自主调度四个工具——📚 知识库检索、🌦️ 气象 API（Open-Meteo）、🕐 时间 API（timeapi.io）、🔎 联网搜索（维基百科 + DuckDuckGo），可回答**任意主题的问题**，用户无需任何配置；气象专业问题仍强制先查知识库并引用来源，每次调用的工具链完整展示；模型调用失败自动回退本地引擎
- **零后端、零构建**：纯静态站点，任何静态托管平台可直接发布

## 本地运行

```bash
cd 气象预报解读助手
python3 -m http.server 8080
# 打开 http://localhost:8080
```

> 需通过 HTTP 服务打开（ES Module 限制），不能直接双击 index.html。
> 知识问答功能完全离线可用；实时天气功能需联网。

## 运行自动化评测

```bash
node tests/eval.mjs
```

评测集含 75 项断言：45 个检索准确性用例（含口语化变体）、4 个库外拒答用例、8 个意图识别用例、3 个地点抽取用例、多轮上下文用例、知识库结构完整性检查、全能模式工具层与 Agent 循环测试（LLM 用 mock，离线可跑）。当前通过率 100%。

## 发布到公网（任选其一，均免费）

本项目是纯静态站点，把整个文件夹上传即可：

**方式一：Netlify Drop（最快，无需注册命令行）**
1. 打开 https://app.netlify.com/drop
2. 把 `气象预报解读助手` 文件夹拖进页面
3. 数秒后获得 `https://xxx.netlify.app` 公开链接

**方式二：GitHub Pages**
```bash
git init && git add . && git commit -m "weather agent"
gh repo create weather-agent --public --source=. --push
gh api repos/{owner}/weather-agent/pages -X POST -f build_type=workflow 2>/dev/null || true
# 或在仓库 Settings → Pages → Branch 选 main / root
```

**方式三：Vercel / Cloudflare Pages**
```bash
npx vercel --prod          # 或
npx wrangler pages deploy .
```

发布后无需任何环境变量或服务端配置。

## 目录结构

```
气象预报解读助手/
├── index.html          # 入口页面（UI 骨架 + 设置弹窗）
├── assets/style.css    # 样式
├── src/
│   ├── kb.js           # 结构化知识库（38 条目 + 来源表 + 天气编码映射）
│   ├── engine.js       # 核心引擎：意图识别/混合检索/置信度/实时解读（纯逻辑，Node 可测）
│   ├── tools.js        # 全能模式工具层：知识库/气象/时间/搜索四个工具的 Schema 与执行器
│   ├── llm-agent.js    # 全能模式 Agent 循环（OpenAI 兼容 function calling，最多 6 轮）
│   └── app.js          # UI 层：渲染、事件、上下文串联、模式切换
├── tests/eval.mjs      # 自动化评测集（75 项断言）
├── package.json
└── README.md
```

## 知识库维护

- 内置模型：接口地址与模型名固定在 `src/app.js` 的 `LLM_CONFIG` 常量中，更换供应商只需改这一处
- 新增知识：在 `src/kb.js` 的 `KB` 数组中追加条目（id/category/title/keywords/answer/sources/safety/followups）
- 每次修改后运行 `node tests/eval.mjs` 回归验证，并为新条目在 `tests/eval.mjs` 中添加检索用例
- 来源新增：在 `SOURCES` 表中登记名称与文件路径，保证可追溯

## 免责声明

本助手仅提供预报知识解读与参考性风险提示。涉及安全、作业、出行、应急的决策，请以当地气象部门发布的最新官方预报和预警为准。
