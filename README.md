# ChaoxingHomeworkPageCracker

面向学习通/超星作业页面的独立 Userscript 自动答题器。脚本在浏览器页面内运行，负责题目提取、LLM 调用、答案匹配、页面填选，以及可选的暂存/提交流程。

## 项目定位

这个仓库只维护独立作业脚本：

```text
chaoxing_homework_llm.user.js
```

它不依赖原刷课脚本，不接入第三方题库服务，而是通过用户自行配置的 LLM API 完成题目推理。

## 功能

- 自动识别学习通作业列表中的未完成作业
- 自动进入作业/题目页面
- 支持单选题、多选题、判断题、填空题、简答题的页面提取
- 支持 OpenAI / Codex Responses API
- 支持 OpenAI 兼容 Chat Completions API
- 支持 Claude Messages API
- 用户在页面浮窗内自行配置 API URL、API Key、模型名
- 自动把模型答案映射到页面选项并点击
- 可选自动暂存/保存
- 可选自动提交
- 暴露调试入口给开发者检查题目提取结果

## 运行环境

- Chromium / Edge / Chrome
- Tampermonkey 或 ScriptCat
- 可访问目标 LLM API 的网络环境

## 安装

1. 安装 Tampermonkey 或 ScriptCat。
2. 新建用户脚本。
3. 复制 `chaoxing_homework_llm.user.js` 全部内容并保存。
4. 打开学习通作业列表页或作业题目页。
5. 页面右下角会出现 `学习通作业 LLM` 面板。

## 配置项

| 配置 | 说明 | 示例 |
| --- | --- | --- |
| 接口类型 | 选择 API 协议适配器 | `OpenAI / Codex Responses API` |
| 调用 URL | 可填 base URL 或完整 endpoint | `https://api.openai.com/v1` |
| API Key | 用户自己的 API Key | `sk-...` |
| 模型名 | 实际调用的模型 | `gpt-4.1` / `claude-3-5-sonnet-latest` |
| 每批题数 | 一次发送给模型的题目数量 | `8` |
| 填题间隔 | 两次页面填选之间的等待时间 | `900` |
| 连续进入未交作业 | 从列表页循环处理未完成作业 | enabled |
| 自动暂存/保存 | 答完后调用保存流程 | optional |
| 自动提交 | 答完后调用提交流程 | optional |

### API URL 规则

脚本会根据接口类型自动补全 endpoint：

```text
OpenAI / Codex Responses API:
  https://api.openai.com/v1
  -> https://api.openai.com/v1/responses

OpenAI compatible Chat Completions:
  https://api.openai.com/v1
  -> https://api.openai.com/v1/chat/completions

Claude Messages API:
  https://api.anthropic.com
  -> https://api.anthropic.com/v1/messages
```

如果你已经填写完整 endpoint，脚本会直接使用。

## 开发者视角：整体架构

脚本是单文件浏览器 Userscript，主要由以下模块组成：

```text
UI Panel
  ├─ 配置读取/保存
  ├─ 启动、停止、只答当前页
  └─ 运行日志

Question Extractor
  ├─ getQuestionRoots()
  ├─ inferType()
  ├─ extractOptionsFromRoot()
  └─ extractQuestions()

LLM Adapter
  ├─ OpenAI Responses API
  ├─ OpenAI-compatible Chat Completions
  └─ Claude Messages API

Answer Resolver
  ├─ parseAnswerJson()
  ├─ parseLabels()
  ├─ findOptionByAnswer()
  └─ applyAnswer()

Navigation / Submission Controller
  ├─ collectUnfinishedWorks()
  ├─ enterNextWork()
  ├─ saveWork()
  └─ submitWork()
```

## 模型返回协议

脚本要求模型只返回 JSON：

```json
{
  "answers": [
    {
      "id": "题目id",
      "answer": "A",
      "confidence": 0.92
    }
  ]
}
```

不同题型的 `answer` 约定：

| 题型 | answer |
| --- | --- |
| 单选题 | 一个大写字母，例如 `A` |
| 多选题 | 升序字母串，例如 `ACD` |
| 判断题 | 按页面给出的选项返回对应字母，或返回 `对` / `错` |
| 填空题 | 简洁答案文本 |
| 简答题 | 简洁答案文本 |

## 页面调试入口

脚本会挂载一个全局调试对象：

```js
window.__chaoxingHomeworkLLM
```

常用调试命令：

```js
// 查看当前页面识别出的题目
__chaoxingHomeworkLLM.extractQuestions()

// 只处理当前页面，不自动提交/返回列表
__chaoxingHomeworkLLM.answerCurrentPage(false)

// 手动启动连续处理
__chaoxingHomeworkLLM.start()

// 停止连续处理
__chaoxingHomeworkLLM.stop()

// 查看当前配置
__chaoxingHomeworkLLM.getCfg()
```

## 选择器适配

题目识别从 `getQuestionRoots()` 开始。当前内置选择器覆盖学习通常见结构：

```js
[
  '.Py-mian1',
  '.TiMu',
  '.newTiMu',
  '.questionLi',
  '.question-item',
  '.quesItem',
  '.paper_question',
  '.mark_item',
  '.subject-item',
  '[data-questionid]'
]
```

如果页面版本变化，优先调整：

1. `getQuestionRoots()`：题目容器定位
2. `titleText()`：题干提取
3. `extractOptionsFromRoot()`：选项提取
4. `clickOption()` / `isSelected()`：选项点击与选中态识别

## 本地校验

当前项目没有构建步骤。提交前执行 JavaScript 语法检查：

```bash
node --check chaoxing_homework_llm.user.js
```

## 文件说明

```text
.
├── chaoxing_homework_llm.user.js   # Userscript 主文件
├── README.md                       # 开发文档
└── .gitignore                      # 本地忽略规则
```

## 开发建议

- 保持单文件发布形态，方便用户直接复制到脚本管理器。
- 新增 provider 时只扩展 `buildEndpoint()` 与 `askLLM()`。
- 新增页面结构适配时优先补充选择器，不要破坏已有通用逻辑。
- 修改提交/保存逻辑时优先调用页面已有函数，例如 `submitAction()`、`noSubmit()`。
- 调试题目识别时先使用 `extractQuestions()`，确认题干、题型、选项均正确后再调试模型调用。
