# GPT Exporter 2.0 验证记录

本地验证日期：2026-09-14。范围：源码、模拟 API 状态机及独立 Chromium 浏览器。没有调用真实 Notion 数据库写入。

## 通过的验证

- `npm run check`：全部扩展 JavaScript 与 Tampermonkey 脚本语法检查通过。
- `npm test`：12 项测试通过。覆盖新增/不变/改名/移动项目/归档状态/未知时间/工作区隔离、当前节点分支与异常父链、缓存过期、缺失更新时间不可替代为创建时间、等待写入、manifest 路径及元数据、严格项目 fallback、重复 canonical key、429 重试提示、写入成功但响应丢失后的分段重放、逐页扫描检查点、Unicode 分段无损，以及完整 worker 扫描—审核—同步—失败重试—从中途检查点重新加载 worker。
- `tests/browser.cjs`：真实 Chromium 136 + Playwright 1.51.1，通过 MV3 后台启动、options 配置保存、token 输入清空、未打开 ChatGPT 的错误提示、popup 渲染、声明式 MAIN 页面面板、跨隔离世界逐页扫描进入审核状态。
- 浏览器中用假 token 验证：content script 的本地存储里没有 token，网页来源看不到扩展私有 IndexedDB，来自网页标签页的后台控制请求被拒绝。
- 自动写入关闭的扫描测试：Notion 请求数为 **0**。
- 已人工查看 options 和页面导出截图：未发现截断、控件重叠或明显不可读文字。

## 验证中修复的问题

- 定时扫描绕过自动写入开关。
- 项目列表异常被吞掉、重复分页和缺失游标导致扫描状态不可靠。
- 设置页在独立标签页内打开时被误判为网页发送者。
- 对 `storage.local.setAccessLevel` 的运行时依赖导致测试浏览器启动失败：敏感同步状态改为扩展来源 IndexedDB。
- 旧 DOM script 注入受测试页面字符编码影响：改用 Chrome 声明式 MAIN / ISOLATED content scripts。
- Unicode 分段在代理对边界可能截断文字。

## 尚未验证或不保证的范围

- 未连接用户实际 Notion integration、三个 data source ID 及既有 schema；部署前需在 UI 执行连接测试，并检查首次同步结果。
- 未用用户真实 ChatGPT 账户执行大规模全量扫描。内部 API 仍可能随上游变化而失效，程序对此应显示错误而非宣称完整。
- 模拟重启测试不等于在真实账户上验证了所有 service worker 终止时机。
- 不支持多写入者的强 exactly-once 事务；Notion 无 canonical ID 唯一约束。发现重复 ID 时停止相关 upsert，需人工合并。
- 正文在 Notion 里保留为 Markdown 原文分段，不是完整 Markdown → Notion 原生富文本转换。图片/音频附件不自动下载。
