# 当前架构与代码地图

**设计与实现边界（2026-11-26）。** 唯一目标架构见 [03](03-技术架构.md)，产品范围见 [01](01-PRD.md)。按新项目初始化，不安排历史数据迁移或旧接口兼容。当前入口使用 `/api/v1`、SQLite Repository、TaskService 与 Codex app-server。工作台支持需求讨论、附件上传与整理、人工确认制作范围、系统生成及当前源码预览和下载。「录制与审片」支持方案编辑、讲解试听、脚本包下载、人工录制与原片交付。Windows 桌面链路待真实环境验收，后期和审片在第 7 项实施。

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
| 人工确认制作范围 | `src/RequirementsPanel.tsx`、`server/requirements.ts`、`server/store/repository.ts` | GET/PUT `/api/v1/projects/:id/requirements`，PUT 要求 If-Match。 `test/system-publication.test.mjs` |
| 系统生成与当前源码 | `server/services/projects.ts`、`server/system-source.ts`、`server/spec.mjs`、`server/artifacts.ts` | POST messages 的 `purpose=system`，构建阶段 `build_system`，成功事件含 `sourceArtifactId`。 `test/system-publication.test.mjs` |
| 当前方案与 Codex 方案提案 | `server/plans.ts`、`server/ai/output-schemas.ts`、`server/ai/context-mcp.mjs` | GET/PUT `/api/v1/projects/:id/plan`，PUT 要求 If-Match。消息 `purpose=plan` 的提案在任务结果中返回。 `test/plans.test.mjs`、`test/ai-adapter.test.mjs` |
| 录制准备与人工启动界面 | `src/HandoffPanel.tsx`、`src/main.tsx`、`src/api.ts`、`src/useTaskEvents.ts` | 「开始录制」提交当前 `planToken`、`scriptArtifactId` 和 `requestId`，任务 SSE 显示准备、采集和步骤进度。界面提供停止、原片播放和下载。 |
| 正式录制和采集成果 | `server/recording.ts`、`server/recording-media.ts`、`server/recording-results.ts`、`server/workers.ts` | POST `/api/v1/projects/:id/recordings` 和通用任务取消接口。合成录制与 JSONL 协议见 `test/recording.test.mjs`。 |
| Windows 桌面执行 | `workers/desktop/main.py`、`native.py`、`observer.py`、`capture.py` | Windows 会话命名互斥量，固定 Edge 实例，PyAutoGUI 输入，只读 Playwright 和 Win32/UI Automation，FFmpeg 采集。合成坐标与时序见 `workers/desktop/test_desktop.py`。 |
| 脚本编译与下载 | `server/scripts.ts`、`template/automation/` | POST `/api/v1/projects/:id/scripts`，用 requestId 幂等并返回 taskId。ZIP 包可用 `python execute.py --check` 离线检查。 `test/scripts.test.mjs` |
| 成果发布、可用性与内容读取 | `server/artifacts.ts`、`server/store/repository.ts`、`server/http.ts` | GET `/api/v1/projects/:id/artifacts` 和 `/api/v1/artifacts/:id/content?projectId=…`。视频支持单段 Range，下载加 `download=1`。 `test/artifacts.test.mjs` |
| 输入限制、模型输出结构与页面标识 | `server/spec.mjs` 的 `parseBrief`、`parseGenerated` | `test/generated.test.mjs`；生成输出 Schema 与[拟定的录制契约](04-Demo-Contract.md) 用途不同 |
| 当前源码预览 | `server/preview.ts`、`server/http.ts`、`src/main.tsx` 的 `SourcePreview` | 「打开预览」调用无请求体的 POST `/api/v1/projects/:id/preview`，成功返回 `data.previewUrl`。`test/preview.test.mjs`、`test/system-publication.test.mjs`。 |
| 生成系统的运行与数据访问 | `template/generated-server.mjs` 提供沙箱页面与样例、状态 API | 固定模板进入源码 ZIP 的 `server.mjs`。`template/server.mjs`、`demo.mjs`、HTML/CSS 提供旧格式固定录入页面。 |
| 工作台启动、构建、依赖版本 | `启动工作台.cmd`、`scripts/find-codex.ps1`、`package.json` | Windows 启动时先从 PATH 查找 Codex CLI，再从当前 OpenAI.Codex 应用包解析路径并设置 `DEMO_STUDIO_CODEX`；`package-lock.json` 锁定依赖，`tsconfig.json` 配置前端类型检查，`tsconfig.server.json` 配置 NodeNext 后端编译 |

## 状态与数据边界

- **工作台与任务。** `server/studio.mjs` 启动本机 HTTP 服务并装配 `createHttpApp`、SQLite Repository、TaskService 和 Codex app-server。任务状态和事件会更新 SQLite；TaskService 进程内持有活动执行与取消句柄。新任务使用 `projects/<projectId>` 作为 AI 工作目录，适配器校验器和 MCP helper 从应用根目录加载。
- **存储与事件。** `server/store/` 使用 Node 内置 `node:sqlite`，启用外键和 WAL。Repository 保存项目、条款、会话、消息、任务、事件、成果及 requestId 幂等键。SSE 按数据库游标续读，客户端按 seq 去重。启动时把中断的系统生成和脚本打包标为 interrupted，并按文件状态收尾待发布 ZIP。工作台持有独立的 `instance.sqlite` 排他事务，避免同一数据根被多实例同时处理。
- **文件安全。** 成果文件按项目归属查询，读取时要求 projectId 并校验真实路径位于所属项目目录。HTTP 写请求校验本地 Host 和同源 Origin，JSON 上限 1 MiB，附件 multipart 单文件上限 20 MiB。文件名由服务生成，原名只用于材料展示。上传先持久化原件，提取成功后才列入 AI 材料索引。失败可下载原件、查看任务原因。PDF 使用 PDF.js 页码，DOCX 使用 Mammoth 原文段落，TXT、Markdown、JSON、CSV 按 UTF-8 原文行号。提取限制为 800 万 UTF-16 代码单元和 10 万个位置，PDF 最多 1 万页，DOCX ZIP 声明解包大小上限 64 MiB。无文字的扫描件提示提供可读文本。
- **连接与配置。** 连接表只保存凭据引用，真实密钥通过标准输入交给 Windows 凭据管理器，接口返回配置状态。连接被活动任务引用时拒绝修改。当前只有 Codex 接入任务执行，其他连接可登记。连接列表显示当前进程最近一次 probe，Codex 检查走 app-server 初始化。生效配置按默认值、全局、项目逐叶合并，写入以 If-Match 判断冲突，null 删除该叶子，显示、采集和输入边界始终由服务注入。
- **试听与材料任务。** 试听以任务开始时的配置快照执行，字体和音色服务的实际可用性由目标机检查。试听接口接收选中讲解的当前文本，生成音频成果，使用 edge-tts 和项目执行权，不申请桌面。可用 `DEMO_STUDIO_EDGE_TTS` 指定本机 edge-tts 可执行文件。界面使用任务事件报告进度，通过项目成果 URL 播放当前讲解的试听结果。材料整理按本轮实际读到的工具原文校验引用，正文和引用作为待确认草稿展示在对话中。
- **方案与脚本。** 每项目一行当前方案。保存允许缺字段并返回 JSON Pointer 问题。Ajv 读取 04 的方案与交接 Schema，脚本服务另核对项目、人工确认条款、源码 ZIP 内的引用和准备策略。脚本固定编译时的有效设置、源码 ID 和方案 token。保存草稿、调整需求范围或替换当前源码后，旧脚本列表项标记 `stale`。源码引用可写 `路径#文本片段`，实际页面定位在录前验证。
- **录制准备状态。** `HandoffPanel` 按项目挂载，工作台在当前页面会话中按项目保留未保存文本、编辑令牌和最近提案任务 ID。提案来自任务详情，经载入后进入本地草稿。PUT 成功才更新当前方案。409 后重新读取并展示服务端内容，用户可采用服务端版本，也可保留本地文本并显式更新保存基线。脚本列表使用服务端失效标记，并核对成果元数据的方案令牌及源码 ID 后展示当前下载。
- **成果发布。** 服务索引 pending 后写入同目录临时文件。再次确认任务状态后，在事务内改名、更新索引和适用的当前指针，并写入事件。失败保留原指针，取消留下的文件标 partial，可显式下载。成果列表显示文件缺失和当前指针，正常源码只列当前项。
- **人工确认与生成。** Codex 的整理结果以提案供用户载入。只有用户保存的条款进入 SQLite 制作范围。更新项目需求描述撤销全部确认，更新既有条款撤销对应确认。生成要求范围非空且全部确认，任务提交时再次核对确认范围和源码指针。
- **源码发布。** 生成复用现有校验器和固定 Node 模板，按成果发布事务更新当前源码、使旧方案和脚本失效并写入成功终态。成功提交后关闭旧预览。Drizzle 的依赖状态及 SQLite 实测边界见 [开发状态](STATUS.md)。
- **预览生命周期。** 按项目串行打开及回收会话，读取 `currentSourceId` 指向的可用源码并复用成果归属、真实路径和 ZIP 条目检查。模板按 ZIP 文件布局选择，生成格式加载页面与样例，旧格式加载 `spec.json`、`seed/records.json` 和内置录入页面。服务端代码来自固定模板。工作台 iframe 保留沙箱，生成页面在内层使用隔离来源，旧格式固定脚本保留其同源数据访问。服务监听 `127.0.0.1` 的临时端口，健康检查通过后返回地址，并复核启动期间的当前源码。重复打开复用会话。启动失败、源码替换和 Fastify 关闭时回收监听和 `projects/<projectId>/previews/session-*` 临时数据。预览读取项目和源码索引，试用写入限于会话内的 `.runtime`。
- **录制启动与准备。** 同源工作台 POST 才创建 `record` 任务。服务复核条款确认、当前 ready 方案、源码及脚本 ZIP，保存有效方案、表现配置与准备策略快照。先以 edge-tts 合成各段，并读取 SRT 与 ffprobe 实长。之后尝试取得服务内桌面占用，再由 Python 获取当前 Windows 交互会话的命名互斥量。桌面忙若在语音准备后发现，由已接受任务报告 `RESOURCE_BUSY`。录制复用当前源码的本机预览会话，生成格式将业务观察限定在 `/demo` iframe，`seed` 和 `custom` 仅写该会话的状态文件。旧格式使用固定页面并保留演示数据。
- **Worker 与收尾。** Node 通过 UTF-8 JSONL 发送 `prepare/start/cancel/ping`，核对命令确认、任务和进程序号后写入 SQLite 事件。Windows Worker 检查前台 Edge、单主屏、任务栏、Network 与物理坐标，采集确认首帧后才执行步骤。录制可由任务取消或 `Ctrl + Alt + Shift + F10` 停止。双向心跳失联后停止输入、封闭原片。Windows Job Object 约束 Edge 与 FFmpeg 的子进程生命周期。启动恢复检查旧 Worker PID 及其任务标记，排除 PID 复用。进程还存在且归属无法确认时保留占用，确认退出后标记 interrupted，允许人工发起新任务。
- **采集交接。** 步骤、检查实测和时间锚点通过 `step.*` 事件持久化。原片按实际 PTS 对齐单调时钟，经 ffprobe、步骤顺序、时长、矩形及交接 Schema 核对后，原片和 `metadata.subtype=capture_manifest` 清单一起发布，项目进入 `media` 阶段。失败、停止或中断将已存在的原片标记为 `.partial`，仅供显式下载。第 7 项接入正常后期任务。交接字段见 [录制契约](04-Demo-Contract.md)。

## 运行与验证

工作台要求 Node.js ≥22.12，前端采用 React 19、TypeScript 5.9 和 Vite 7。真实生成还需本机可调用且已登录的 Codex。以下命令在工程根目录执行。

| 操作 | 命令与预期结果 |
|---|---|
| 安装锁定依赖 | `npm ci` |
| 构建或刷新页面 | `npm run build` 编译 `dist-server/`、检查前端类型并输出 `dist/`。 |
| 编译新 AI 后端 | `npm run build:server`，输出 NodeNext 模块到 `dist-server/`。 |
| 初始化 SQLite 空库 | `DEMO_STUDIO_DATA_DIR=<临时目录> npm run init:store`；Windows PowerShell 使用 `$env:DEMO_STUDIO_DATA_DIR` 设置临时目录。命令编译后端并执行 `dist-server/index.js`，仅创建 `studio.sqlite` 结构。 |
| 启动工作台 | `npm start`，浏览器打开 `http://127.0.0.1:17860`。Windows 也可双击 `启动工作台.cmd`。 |
| 回归或定向验证 | `npm test` 先编译 TypeScript 后端，再用 `--experimental-sqlite` 运行 Node 内置测试。工作台请求用进程内注入。预览用例另启动本机回环临时端口验证健康检查、模板响应和服务回收。定向命令为 `node --experimental-sqlite --test test/preview.test.mjs test/system-publication.test.mjs`。 |
| 录制工程检查 | 编译服务端后运行 `node --experimental-sqlite --test test/recording.test.mjs`。运行 `python -B -m unittest discover -s workers/desktop` 检查合成坐标、时序、数据与取消。 |
| 录制依赖 | 用户在 Windows 为所选 Python 安装 `python -m pip install -r workers/desktop/requirements.txt` 中的依赖，并准备 Edge、edge-tts、带 gdigrab/libx264 的 FFmpeg 和 ffprobe。可用 `DEMO_STUDIO_PYTHON`、`DEMO_STUDIO_EDGE_TTS`、`DEMO_STUDIO_FFMPEG`、`DEMO_STUDIO_FFPROBE` 指定本机可执行文件。 |
| 验证独立交付物 | 在解压目录运行 `node server.mjs` 或双击 `启动演示.cmd`，新格式默认地址为 `http://127.0.0.1:18080`。 |

工作台端口和数据根目录可用 `DEMO_STUDIO_PORT`、`DEMO_STUDIO_DATA_DIR` 覆盖。验证时将数据根目录指向临时目录。导出系统端口用 `DEMO_PORT` 调整。日常使用步骤见 [README](../README.md)。
