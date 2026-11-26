# 当前架构与代码地图

**设计与实现边界（2026-11-26）。** 唯一目标架构见 [03](03-技术架构.md)，产品范围见 [01](01-PRD.md)。按新项目初始化，不安排历史数据迁移或旧接口兼容。当前入口使用 `/api/v1`、SQLite Repository、TaskService 与 Codex app-server。工作台开放需求讨论、附件上传与整理、连接检查及全局和项目表现设置。人工确认需求、系统交付与预览、录制及审片按后续清单推进。

工作台是本地 Node.js Fastify 服务，提供 React 页面与 /api/v1 项目、对话、任务和 SSE 事件接口。Codex app-server 通过 stdio 子进程执行；任务与事件写入 SQLite。Fastify 负责路由、请求校验和注入测试；工作台不读取历史 job.json，也不提供 /api/jobs 兼容路由。

## 按任务定位

| 要处理的任务 | 首先查看 | 关联入口或验证 |
|---|---|---|
| 工作台界面、需求表单、对话和统一活动 | `src/main.tsx`、`src/api.ts`、`src/useTaskEvents.ts` | `src/style.css`；[工作台设计](02-工作台设计.md) |
| 项目/消息/任务 HTTP API、来源校验和 SSE | `server/http.ts`、`server/services/projects.ts`、`server/events.ts` | `test/http.test.mjs`、`test/events.test.mjs`、`test/conversation.test.mjs` |
| 工作台启动、SQLite/TaskService 装配和静态资源 | `server/studio.mjs` 的 `createStudio` | `test/studio.test.mjs`；`npm start`、`启动工作台.cmd` |
| Codex 启动、续聊、技能摘要与调用凭据核对 | `server/codex.mjs` 的 `generateWithCodex` | `server/mcp-brief.mjs` 注册 MCP 工具；[技能正文](../.agents/skills/bid-demo-system/SKILL.md) 随工程维护 |
| 统一 AI 类型、Codex app-server 会话、事件、取消与任务状态 | `server/ai/contracts.ts`、`server/ai/codex-app-server.ts`、`server/ai/rpc-client.ts`、`server/tasks.ts` | `test/ai-adapter.test.mjs`、`test/task-service.test.mjs` 使用合成 app-server；HTTP 由 `studio.mjs` 装配 |
| SQLite 表结构、空库初始化、事务与 Repository | `server/store/schema.ts`、`server/store/repository.ts`、`server/index.ts` | `test/store.test.mjs`；`npm run init:store` 在 `DEMO_STUDIO_DATA_DIR` 指定目录创建空库，不读取历史 `job.json` |
| 全局和项目设置、试听 | `server/settings.ts`、`src/SettingsPanel.tsx`、`server/services/artifact-jobs.ts`、`server/speech.ts` | GET/PUT `/api/v1/settings` 和 `/api/v1/projects/:id/settings`，POST `/api/v1/projects/:id/speech-preview`。`test/settings.test.mjs` |
| 连接管理、探测及凭据 | `server/connections.ts`、`server/credentials.ts` | `/api/v1/connections` 的列出、创建、修改、探测及独立凭据删除。 `test/credentials.test.mjs` |
| 上传、提取与需求来源 | `server/attachments.ts`、`server/services/artifact-jobs.ts`、`server/ai/context-mcp.mjs`、`server/ai/output-schemas.ts` | POST `/api/v1/projects/:id/attachments`，`read_attachment`，消息 `purpose=requirements`。 `test/attachments.test.mjs`、`test/ai-adapter.test.mjs` |
| 输入限制、模型输出结构与页面标识 | `server/spec.mjs` 的 `parseBrief`、`parseGenerated` | `test/generated.test.mjs`；生成输出 Schema 与[拟定的录制契约](04-Demo-Contract.md) 用途不同 |
| 生成系统的运行与数据访问 | `template/generated-server.mjs` 提供沙箱页面与样例、状态 API | `studio.mjs` 将其打包为导出工程的 `server.mjs`；`template/server.mjs`、`demo.mjs`、HTML/CSS 保留旧格式预览 |
| 工作台启动、构建、依赖版本 | `启动工作台.cmd`、`scripts/find-codex.ps1`、`package.json` | Windows 启动时先从 PATH 查找 Codex CLI，再从当前 OpenAI.Codex 应用包解析路径并设置 `DEMO_STUDIO_CODEX`；`package-lock.json` 锁定依赖，`tsconfig.json` 配置前端类型检查，`tsconfig.server.json` 配置 NodeNext 后端编译 |

## 状态与数据边界

- **工作台与任务。** `server/studio.mjs` 启动本机 HTTP 服务并装配 `createHttpApp`、SQLite Repository、TaskService 和 Codex app-server。任务状态和事件会更新 SQLite；TaskService 进程内持有活动执行与取消句柄。新任务使用 `projects/<projectId>` 作为 AI 工作目录，适配器校验器和 MCP helper 从应用根目录加载。
- **存储与事件。** `server/store/` 通过 Node 内置 `node:sqlite` 打开数据库，启用外键和 WAL。Repository 提供项目/对话/消息/任务/事件/成果查询与写入、任务 requestId 幂等和事件序号。SSE 持续按数据库游标补读，断线后从 `afterSeq` 续读；客户端按 seq 去重。任务执行映射仍在内存，服务重启恢复/标记中断的流程未接入。
- **文件安全。** 成果文件按项目归属查询，读取时要求 projectId 并校验真实路径位于所属项目目录。HTTP 写请求校验本地 Host 和同源 Origin，JSON 上限 1 MiB，附件 multipart 单文件上限 20 MiB。文件名由服务生成，原名只用于材料展示。上传先持久化原件，提取成功后才列入 AI 材料索引。失败可下载原件、查看任务原因。PDF 使用 PDF.js 页码，DOCX 使用 Mammoth 原文段落，TXT、Markdown、JSON、CSV 按 UTF-8 原文行号。提取限制为 800 万 UTF-16 代码单元和 10 万个位置，PDF 最多 1 万页，DOCX ZIP 声明解包大小上限 64 MiB。无文字的扫描件提示提供可读文本。HTTP 测试使用 inject，不绑定端口。
- **连接与配置。** 连接表只保存凭据引用，真实密钥通过标准输入交给 Windows 凭据管理器，接口返回配置状态。连接被活动任务引用时拒绝修改。当前只有 Codex 接入任务执行，其他连接可登记。连接列表显示当前进程最近一次 probe，Codex 检查走 app-server 初始化。生效配置按默认值、全局、项目逐叶合并，写入以 If-Match 判断冲突，null 删除该叶子，显示、采集和输入边界始终由服务注入。
- **试听与材料任务。** 试听以任务开始时的配置快照执行，字体和音色服务的实际可用性由目标机检查。试听接口接收当前讲解文本，生成音频成果，使用 edge-tts 和项目执行权，不申请桌面。可用 `DEMO_STUDIO_EDGE_TTS` 指定本机 edge-tts 可执行文件。方案讲解选择器随方案编辑接入。材料整理按本轮实际读到的工具原文校验引用，正文和引用作为待确认草稿展示在对话中。
- **生成与交付。** 生成器提供页面、脚本、样例和验收条目；工作台提供固定 Node 服务、打包及启动健康检查。新格式产物在任务目录的 `source/`、`source.zip`，预览数据在独立的 `preview/<标识>/`。导出系统启动后把状态写入自身的 `.runtime/`，保留 `seed/` 初态。
- **后续模块。** 人工确认需求、系统交付发布、预览、源码 ZIP、方案编辑、录制和完整后期路线尚未接入。保留生成模板与校验器供后续模块复用。Drizzle 的依赖状态及 SQLite 实测边界见 [开发状态](STATUS.md)。

## 运行与验证

工作台要求 Node.js ≥22.12，前端采用 React 19、TypeScript 5.9 和 Vite 7。真实生成还需本机可调用且已登录的 Codex。以下命令在工程根目录执行。

| 操作 | 命令与预期结果 |
|---|---|
| 安装锁定依赖 | `npm ci` |
| 构建或刷新页面 | `npm run build` 编译 `dist-server/`、检查前端类型并输出 `dist/`。 |
| 编译新 AI 后端 | `npm run build:server`，输出 NodeNext 模块到 `dist-server/`。 |
| 初始化 SQLite 空库 | `DEMO_STUDIO_DATA_DIR=<临时目录> npm run init:store`；Windows PowerShell 使用 `$env:DEMO_STUDIO_DATA_DIR` 设置临时目录。命令编译后端并执行 `dist-server/index.js`，仅创建 `studio.sqlite` 结构。 |
| 启动工作台 | `npm start`，浏览器打开 `http://127.0.0.1:17860`。Windows 也可双击 `启动工作台.cmd`。 |
| 回归或定向验证 | `npm test` 先编译 TypeScript 后端，再用 `--experimental-sqlite` 运行 Node 内置测试。HTTP 与 SSE 定向用例使用进程内注入和持久游标，不申请本机回环端口。单测示例为 `node --experimental-sqlite --test test/store.test.mjs`。 |
| 验证独立交付物 | 在解压目录运行 `node server.mjs` 或双击 `启动演示.cmd`，新格式默认地址为 `http://127.0.0.1:18080`。 |

工作台端口和数据根目录可用 `DEMO_STUDIO_PORT`、`DEMO_STUDIO_DATA_DIR` 覆盖。验证时将数据根目录指向临时目录。导出系统端口用 `DEMO_PORT` 调整。日常使用步骤见 [README](../README.md)。
