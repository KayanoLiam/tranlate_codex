# OpenAI Auth 翻译插件开发文档（仅自用）

## 1. 目标与范围
- 目标：做一个仅供本人使用的 Chrome 沉浸式翻译插件。
- 约束：不购买 OpenAI API，优先使用 OpenAI Auth（参考 Codex 的 ChatGPT 登录流）。
- 范围：网页段落翻译、双语对照渲染、基础缓存与重试。
- 非目标：商用发布、多用户系统、复杂账号体系。

## 2. 可行性结论（先定边界）
- 技术上可行：可以通过本地登录态驱动模型调用，实现“账号感”翻译体验。
- 风险可预期：该方案依赖登录流与客户端行为，后续可能变更。
- 合规要求：仅用官方可见登录方式，不做逆向私有接口，不绕过限流或风控。

## 3. 总体架构
采用 `Chrome Extension (MV3) + Local Bridge` 两层结构：

1. 插件层（浏览器内）
- `content script`：抽取正文、分段、回填翻译。
- `background service worker`：请求编排、节流、失败重试。
- `options page`：目标语言、术语表、显示样式配置。

2. 本地桥接层（localhost）
- 本地服务监听 `127.0.0.1`（如 `8787`）。
- 负责模型请求封装、分片翻译、缓存、日志。
- 使用本机 OpenAI Auth 登录态发起调用（按 Codex CLI 官方流程登录）。

## 4. 关键流程
1. 用户点击“翻译当前页面”。
2. `content script` 提取可翻译段落并生成任务队列。
3. `background` 调用 `POST /translate-batch` 到本地桥接层。
4. 桥接层分片调用模型，返回 `[{id, translatedText}]`。
5. `content script` 就地渲染双语块，失败段落标记可重试。

## 5. 接口草案（本地）
`POST /translate-batch`

```json
{
  "sourceLang": "en",
  "targetLang": "zh-CN",
  "items": [{"id":"p1","text":"Hello world"}],
  "mode": "bilingual"
}
```

返回：

```json
{
  "results": [{"id":"p1","translatedText":"你好，世界"}],
  "usage": {"requestCount":1}
}
```

## 6. 迭代里程碑
- M0：选中文本翻译（最小可用）。
- M1：整页段落翻译 + 双语渲染。
- M2：缓存、去重、重试、超时处理。
- M3：术语表与提示词模板（提升一致性）。

## 7. 风险与回退
- 登录流变化导致调用中断：保留“手动切换 provider”设计。
- 速率限制：前端队列 + 桥接层并发上限。
- 隐私：默认不落盘原文；日志仅保留错误摘要。
