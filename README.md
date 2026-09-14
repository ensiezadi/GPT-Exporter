# GPT Exporter 2.0

Chrome MV3 扩展：导出 ChatGPT JSON + 当前分支 Markdown，逐页增量扫描，并通过扩展后台同步到 Notion。Tampermonkey 保留本地导出兼容，不直接同步 Notion。

## 安装和开始使用

1. 下载源码或安装包，解压。
2. 在 Chrome 的 `chrome://extensions` 开启开发者模式，选择“加载已解压的扩展程序”，选择 **chrome-extension** 文件夹。
3. 更新扩展后刷新已打开的 ChatGPT 标签页。不要同时运行旧版 Tampermonkey 导出器和 Chrome 扩展，以免重复注入。
4. 页面右下角的 **Export Conversations** 打开导出面板，可选择 Conversations、Projects、完整备份和高级筛选。
5. 扩展 popup 的 **同步中心** 打开连接配置、增量扫描、失败重试和同步记录。

下载完成提示只表示 ZIP 已生成并交给浏览器；仍需完成系统保存窗口。有失败时会显示详情，可“仅重试失败项”生成补充 ZIP。补充包不会自动修改之前保存的 ZIP。

## Connect Notion

本版是 **internal integration token 配置**，不是 OAuth 授权登录。个人使用无需额外部署服务器。

1. 在 Notion 创建 internal integration，授予所需的读取、插入和更新内容能力。
2. 将现有 **ChatGPT Projects / ChatGPT Conversations / ChatGPT Sync Runs** 三个数据库共享给该 integration。
3. 在扩展同步中心填写三个 **data source ID**。它们不一定等于浏览器 URL 中的 database ID；可通过 Notion 的 Retrieve database API 查看 `data_sources`，选择对应的数据源。API 固定使用 `Notion-Version: 2025-09-03`。
4. 填写 **ChatGPT Workspace ID**，必须与要备份的登录工作区一致。可在 ChatGPT 浏览器开发者工具 Network 中查看其自身请求的 `ChatGPT-Account-Id`，仅复制这个 ID，不要复制 Cookie 或 Authorization。
5. 在扩展设置页输入 Notion token 并保存；留空保留已有 token。不要把 token 发到聊天、粘贴到页面控制台或提交到 Git。
6. 如果既有字段名不同，展开“字段映射”修改 JSON。点击 **测试连接与字段**。此操作仅查询三个数据源的 schema，不创建页面。
7. 点击 **扫描新增与更新**，检查统计，再点击 **开始同步 / 继续 / 重试失败**。

### 默认字段和类型

| 数据源 | 字段 | Notion 类型 |
|---|---|---|
| Projects | Name | title |
| Projects | Project ID、Workspace ID | rich_text |
| Conversations | Name | title |
| Conversations | Conversation ID、Workspace ID | rich_text |
| Conversations | Project | relation，指向 Projects 数据源 |
| Conversations | Created At、Updated At | date |
| Conversations | Archived | checkbox |
| Sync Runs | Name | title |
| Sync Runs | Run ID、Status、Error | rich_text |
| Sync Runs | Started At、Finished At | date |
| Sync Runs | Completed、Failed | number |

三个数据源及字段需要事先存在；本版不自动修改数据库结构。`Status` 是文本字段，不能直接映射到 Notion 的 status/select 类型。连接测试会指出类型不符的字段。字段类型不同的已有模型需要先配置兼容字段或扩展 adapter。

## 增量与续传逻辑

- **扫描与同步分离**：完整读取活动、归档、项目列表和项目对话分页；每页保存检查点。新条目加入队列，服务器更新时间、标题、项目归属/名称或归档状态变化时重新同步。时间缺失时保守重取。
- **缓存**：按 Workspace ID + Conversation ID 隔离；只有服务器时间可靠且缓存记录的服务器时间不早于它时命中。未知时间和旧版无时间戳缓存一律重新拉取。
- **同步**：Project ID、Conversation ID 为 Notion canonical key，写入前查询；本地同步记录还按 workspace 隔离。相同 ID 出现多个 Notion 页面时停止该条同步并报错。
- **检查点**：扫描页、待办队列、项目页面 ID、当前对话、正文版本和分段索引保存到 扩展自身来源的 IndexedDB。service worker 重启后由 alarm 恢复。页面关闭导致读取失败时，重新打开并登录后点击继续。
- **成功条件**：只有该条正文各分段完成后，才提交本地 `syncedRevision`。失败项保留旧的成功版本，支持只重试失败项。
- **Notion 正文**：当前分支 Markdown 作为原文文本保存在版本 toggle 下，再分成 Part toggle 和段落。Markdown 标记保持为文本，不承诺还原成 Notion 原生代码块、表格或公式。旧版本和人工笔记保留，不做破坏性替换。
- **请求重放**：用正文 SHA-256 查找版本，用 Part 标记查找分段。响应丢失后重试先检查已写内容。遇 429/5xx 会持久保存重试时间并退避；重复失败会暂停或进入失败队列。
- **缺失条目**：某次扫描没有看到的对话不会从 Notion 删除。项目接口不完整、重复分页或缺失必要游标时，不把扫描标为完成。
- **自动执行**：默认关闭。可以设为每小时、每 5 小时或每天扫描。“扫描后自动写入 Notion”开关同时控制手动和定时扫描；不开启时只生成待审核队列。Chrome 退出、电脑休眠或 ChatGPT 未登录时无法准时执行。

扫描期间不要切换登录账户。不要用多个扩展安装实例同时写入相同 Notion 数据源；Notion API 没有 canonical key 唯一约束或跨请求事务，查询后创建无法提供多客户端 exactly-once 保证。网络结果不明确的情况下可能需要人工处理重复页面，程序检测到重复时不会任意选择一个覆盖。

## 导出 ZIP

```text
EXPORT_MANIFEST.json
EXPORT_REPORT.json
conversations/<conversation_id>.json
conversations/<conversation_id>.md
projects/<project_id>/<conversation_id>.json
projects/<project_id>/<conversation_id>.md
```

manifest 包含 `schema_version`、`exporter_version`、`workspace_id`、模式、生成时间、项目 ID/标题、对话 ID/标题、创建/更新时间、归档状态及 JSON/Markdown 相对路径。路径使用完整 ID，不依赖可改名或可能碰撞的项目标题。

JSON 保留完整 mapping。Markdown 从 `current_node` 追溯 parent 并反转，只包含该分支的可见 user/assistant 文本。缺失 current_node、父链缺失或循环时停止该条 Markdown，保留 JSON，manifest 的 `md_path` 为 null，并在报告中记录失败。图片、音频等非文本资源不会在 Markdown/Notion 中自动下载。

## 架构和安全边界

```text
ChatGPT MAIN world：Chrome 声明式注入，读取会话、缓存、生成 ZIP/Markdown
       ↑ 后台发起的限定读取 / ↓ 对应结果
content/sync-bridge.js：Chrome 声明式 isolated world，一次性请求 ID，限定 action
       ↑
sync/worker.js：受信任扩展 UI 发起任务，持久队列、状态、重试
       ↓
sync/notion.js：NotionAdapter → 固定 https://api.notion.com/v1/
```

- token 只在扩展设置页输入，保存于扩展来源的 IndexedDB。content script 的 IndexedDB 属于 ChatGPT 网页来源，无法打开扩展来源的数据库；共享的 chrome.storage.local 只存放无敏感内容的界面刷新时间戳。它不是加密保险库，本机拥有浏览器配置访问权限的人仍可能读取。
- token 不进入 MAIN world、DOM、postMessage、导出包或 Chrome sync。状态接口不返回 token 或正文。
- 后台控制接口只接受本扩展页面来源。content script 只能读取有限公开状态和打开同步中心，不能配置 token、指定任意 URL 或发起同步。
- 页面回复只被用于后台已发起的读取任务；设置凭据、API 地址和写入方法不从页面获取。网页内容仍是不可信输入，恶意网页可篡改自己提供的会话数据，无法仅靠 postMessage 认证其真实性。
- Notion 请求采用固定主机、HTTPS、拒绝重定向和超时；错误只返回状态码及操作类别，不回显 API 响应正文或凭据。
- 只请求 ChatGPT 两个精确站点及 Notion API 的 host permission；不使用通配全部网站权限。

### 可替换 adapter

`createAdapter(config)` 位于 `chrome-extension/sync/notion.js`。替代实现需提供 `test / project / conversation / run / ensureRevision / appendPart`，保证 canonical ID 查询及分段重放语义。如需 OAuth 或中心化同步，应在服务器保管 OAuth client secret/refresh token，并新增具有身份验证、固定目标和严格 schema 校验的 endpoint adapter。本版未部署 endpoint，也未实现 OAuth，不应在配置中随意填写代理 URL。

## 验证和限制

```sh
npm test
npm run check
```

测试覆盖缓存失效、分支、manifest、项目 fallback、增量元数据判断、凭据过滤、消息来源限制、失败重试和写入响应丢失。真实浏览器验收使用独立配置和合成数据，结果见 `VALIDATION.md`。

ChatGPT 使用其网站内部接口，上游变动可能导致扫描失败。本版没有执行真实 Notion 账户写入验收，也没有把测试中的模拟数据写入你的数据库。首次连接应先测试字段结构，再检查少量同步结果，确认符合既有模型。

## 文件入口

- `chrome-extension/pages/dashboard.js`、`styles/dashboard.css`：popup/options 状态界面。
- `chrome-extension/exporter.user.js`：页面 UI、导出、缓存、扫描和 Markdown。
- `chrome-extension/sync/worker.js`：后台状态机与授权入口。
- `chrome-extension/sync/notion.js`：Notion API adapter。
- `chrome-extension/sync/model.js`：增量判断和默认字段映射。
- `chrome-extension/content/sync-bridge.js`、`sync/page-api.js`：隔离世界与页面读取桥。
- `Tampermonkey.js`：兼容导出修复。

原有社区来源和 GreasyFork 元数据保留在 Tampermonkey 文件头。本仓库 2.0 修改不表示 GreasyFork 上的版本已发布更新。

### 可选浏览器回归

安装 Playwright 后运行 `npm run test:browser`，先按其说明安装匹配的 Chromium。也可通过 `PLAYWRIGHT_MODULE` 指定现有 Playwright 模块路径，通过 `BROWSER_EXECUTABLE` 指定 Chromium，通过 `BROWSER_ARTIFACT_DIR` 指定截图目录。测试使用独立临时浏览器配置、合成 ChatGPT 数据和假 token；阻止全部 Notion 请求。不要改成真实账户配置。

参考：[Chrome 跨域请求](https://developer.chrome.com/docs/extensions/develop/concepts/network-requests)、[Notion data source 查询](https://developers.notion.com/reference/query-a-data-source)、[Notion block 分批写入](https://developers.notion.com/reference/patch-block-children)。
