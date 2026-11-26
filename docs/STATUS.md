# 开发状态

更新日期：2026-11-26。05 第 1 至 4 项代码已接入。工作台支持需求讨论、附件提取和需求草稿整理、连接探测及表现设置。人工确认范围、系统交付与预览、方案、录制和完整后期按后续实施项推进。

## Codex CLI 启动兼容修复（2026-11-26）

- 移除 Codex app-server 启动参数 `--ignore-user-config`，兼容本机 `codex-cli 0.171.0-alpha.13.2`。保留显式 `approval_policy="never"` 与 `sandbox_mode="read-only"`。
- 「启动工作台.cmd」通过 `scripts/find-codex.ps1` 先查 PATH，再从已安装的 OpenAI.Codex 应用包动态拼接 CLI 路径；不依赖版本目录。解析结果传入 `DEMO_STUDIO_CODEX`。
- 初始化响应兼容标准 `serverInfo.name/version` 与当前 CLI 返回的 `userAgent`；后者解析为 Codex Desktop/CLI 名称和版本。
- `npm run build:server` 通过，`node --experimental-sqlite --test test/ai-adapter.test.mjs` 12/12 通过；当前 CLI `app-server --print-startup-config` 确认权限配置有效。
- 修复双击闪退：本机 `cmd.exe` 默认代码页 936 下，LF 格式启动脚本在构建前报 `& was unexpected at this time.`。将启动脚本恢复为 CRLF，并通过 `.gitattributes` 规定 `.cmd` 签出时使用 CRLF。
- 使用 Windows 文件关联打开原启动脚本，临时端口返回 HTTP 200，Edge 自动打开工作台。从 PATH 移除 WindowsApps 并清除 Codex 路径覆盖后，仍能在新建临时项目发送“你好”，页面显示“你好！有什么演示需求或问题，我们可以接着讨论。”。完整构建及 `npm test` 41/41 通过，临时服务和数据已清理。

## 当前实现与历史检查

| 事项 | 状态与依据 |
|---|---|
| 新统一 AI 与 app-server 核心 | `server/ai/` 与 `server/tasks.ts` 已由 `server/http.ts`、`server/services/projects.ts` 和 `server/studio.mjs` 接入；会话、消息/工具事件、结果校验、取消、人工输入和 Worker 异常由合成 app-server 用例覆盖。真实 Codex CLI 初始化及工作台问候对话已验证。 |
| 项目/对话/任务 HTTP 与 SSE | `/api/v1` 已支持项目列表/创建/读取/修改、消息读取/提交、任务读取/取消、成果列表/按项目读取。写请求有 Host/Origin/JSON/大小校验；SSE 以持久化 seq 游标补读，断线不取消任务。没有旧 `/api/jobs` 兼容路由。 |
| 前端 | `src/api.ts` 和 `src/useTaskEvents.ts` 使用项目/任务 DTO 与 SSE，更新活动、附件状态和待确认需求草稿。`src/SettingsPanel.tsx` 显示全局/项目配置、生效来源、保存冲突与 Codex 探测。 |
| 设置、连接与材料 | 工作台入口、依赖、数据边界和接口详见 [代码地图](ARCHITECTURE.md)。默认、全局、项目按叶继承，If-Match 冲突保护，凭据由独立适配器处理。附件保留原件，TXT/Markdown/JSON/CSV、PDF 和 DOCX 按原文位置建立引用。 |
| 预览、源码 ZIP、录制交接 | 生成校验器和模板仍保留，但当前入口没有接入产物发布、预览、ZIP、录制或审片路由；历史 `.studio/jobs` 数据不读取、不迁移。 |
| SQLite 存储 | `server/store/` 提供项目、连接、会话/消息、任务/事件/成果的读写查询，事务、requestId 幂等、事件序号、路径隔离、方案/设置比较保存及活动写任务唯一索引。使用 Node 内置 `node:sqlite`，服务启动不扫描历史 `job.json`。 |
| SQLite 与依赖 | Node v22.23.2 使用内置 node:sqlite，以 `--experimental-sqlite` 运行。项目锁定 Fastify 5.12.8、`@fastify/multipart@9.4.0`、`pdfjs-dist@4.10.38` 和 `mammoth@1.11.0`。Drizzle 尚未安装。 |
| Git | 本版包含 05 第 4 项与 Windows 启动修复，提交记录见 `master` 分支。Codex 自动生成的本机环境文件差异单独保留。 |

## 05 第 4 项：设置、连接、凭据与附件

- 设置 API 输出保存值、生效值、逐叶来源和 editToken/ETag。项目值缺省时继承全局，null 移除覆盖。If-Match 缺失返回 428，版本冲突返回 409。缺音色只阻止音频准备。
- 提供连接列出、创建、修改、删除凭据和探测。Windows 实现使用当前用户的凭据管理器。替换凭据时先写新项，数据库失败时删除新项，数据库更新成功后清理旧项。通过假存储核对 HTTP、SSE 和 SQLite 正文未包含密钥。
- 通过 multipart 上传材料。原件按项目隔离，提取在独立任务中记录。PDF 使用真实页码，DOCX 使用提取段落号，其他支持格式保留原文行号。扫描 PDF 无可读文本时任务报错并保留原件。
- Codex `requirements` 使用独立原生 Schema。服务器校验原文引用确实来自本轮读取的附件片段，交付条目保持待人工确认。现有 `system` 入口仍要求先确认范围，人工确认工作流待接入。
- 试听端点在开始时保存生效配置快照，产出独立音频任务，无桌面依赖。已用注入合成器覆盖配置快照、失败收尾及其他项目可继续操作。方案中选中讲解后的试听 UI 待方案编辑接入。
- 工程验证通过：`node --experimental-sqlite --test test/settings.test.mjs test/credentials.test.mjs test/attachments.test.mjs` 9/9，`npm test` 41/41，`npm run build` 通过。初次定向失败是无请求体的 DELETE 在测试中误带 JSON Content-Type；初次全量失败补齐了 MCP 工具清单断言，并修复 app-server 初始化退出可能产生未处理 Promise rejection 的问题。复跑无失败。
- 实测边界：单元与注入测试使用临时目录、合成文件、假凭据存储、假语音服务和合成 app-server。PDF.js、Mammoth 和生产 MCP 读取脚本已用合成材料执行。真实 Codex CLI 登录会话、app-server 初始化和一轮工作台对话已验证，真实 HTTP 监听及浏览器操作也已在临时项目验证；Windows 凭据管理器、edge-tts 联网合成、正式演示与录屏未实测。

## 本轮文档收敛

- 保留 01–05 作为需求、交互、目标架构、契约和实施计划，删除重复产品索引、独立证据汇编及决策表。文档导航统一到 README，产品决定以 01 为准，技术选择和有效来源以 03 为准。
- 将早期 agent.md 的有效职责、AI 接入、上下文与执行边界并入 03，移除重复架构文件。
- 同步方案 Schema 和两个说明性样例，移除构建版本/源清单/隔离运行目录等字段，放宽初末态为场景描述。样例不是默认验收案例。
- 同步当前代码地图说明、README 与开发约定，修正合并后的读取入口；已有代码、依赖和本机任务数据未改变。
- 详细设计已补齐：03 的适配器签名、Codex app-server 协议映射、API Key 工具循环、数据库字段/约束、配置继承、HTTP/SSE、错误码、状态/互斥/恢复；04 的数据准备、脚本包、Worker 协议、采集及媒体交接；02 的 UI/API 对应；05 的八项开发清单和工程检查点。
- 新增 execution-handoff.schema.json，配套方案增加明确的 resetStrategy。静态文档核对记录见上次状态；本轮开始实施清单第 1 项，并更新了 AI 事件中的 app-server 用户输入问题结构。

- 用户已明确不涉及数据迁移；按新项目初始化数据库，不导入历史 job.json 或提供旧路由兼容。新 Codex 适配器直接使用 app-server，无 exec 回退。

## 05 第 3 项实施时的验证记录

- server/http.ts 使用 Fastify 实例注册 /api/v1 路由、安全校验 hook 和 SSE。统一错误映射与项目服务层处理请求，Fastify inject 覆盖生产路由。
- `server/events.ts` 按 SQLite seq 游标持续补读；SSE 收到 Last-Event-ID / afterSeq 时从较大值开始，事件先落库，终态后关闭。客户端使用 Fetch 流解析、断线重连与 seq 去重；工具按 callId 更新，折叠状态保存在组件状态中。
- `server/studio.mjs` 切换到 SQLite + TaskService + Codex app-server。`npm start` 先构建再以 `--experimental-sqlite` 启动，Windows 启动脚本调用 `npm start`。第 3 项开放需求讨论，系统生成需先有确认条款。
- 当前成果读取要求 `projectId`，Repository 校验 artifact 的项目归属、相对路径与实际 realpath；写接口校验本机 Host、同源 Origin、JSON 与 1 MiB 请求上限。
- 定向用例 `test/http.test.mjs`、`test/events.test.mjs` 覆盖重复提交、相同 requestId 异载荷冲突、跨项目文件拒绝、回放期间新增事件、断线补读及终态取消幂等。此前悬挂原因是 `node --test` 把 `test/fixtures/fake-codex-app-server.mjs` 当作测试执行；现已移至 `test-support/` 并更新引用。
- 当时的 `npm run build`、AI/TaskService/存储定向 19/19、HTTP/SSE/对话/启动定向 10/10、`npm test` 31/31 通过。测试使用进程内 HTTP 注入和合成 app-server。
- 第 3 项阶段记录当时尚未实测真实 Codex CLI/app-server；本次完整启动和问候验收见本文顶部修复记录。业务演示仍未实测。

## 05 第 2 项：类型运行链与 SQLite 初始化

- `server/store/schema.ts` 定义 connection、project、requirement、conversation、message、plan、settings、task、event、artifact、review 及索引；`repository.ts` 通过 SQLite 外键、唯一索引、事务和 edit token 实现目标接口。`saveProject` 同时创建空方案和项目设置。`initializeStore(dataRoot)` 可重复创建空库；启动不扫描历史 `.studio/jobs/**/job.json`。
- 第 2 项阶段采用 Node 内置 `node:sqlite`；Node 22.12 需 `--experimental-sqlite`，因此测试、初始化和当前 `npm start` 均带该标志。`npm run build` 同时构建后端和前端。第 2 项当时 `npm start` 尚未切换；本轮第 3 项已将它改为构建后启动 SQLite 工作台入口。
- 存储验收用例位于 `test/store.test.mjs`：空目录重复初始化、保存后关闭重开、损坏的历史 job.json 不影响初始化、活动写任务唯一执行权、事件序号事务回滚、外键拒绝无效引用、重复 requestId、missing 状态及方案/设置 edit token。存储与第 1 项定向用例合计 19/19 通过；编译后的初始化入口已在临时目录创建 `studio.sqlite`。
- 依赖源 DNS 阻断，Drizzle 无法下载，故本轮使用 Node 内置 SQLite 完成数据层，未更改 `package-lock.json`。当前实际 Node 22.23.2 验证成功；Node 22.12 的实际二进制未安装，兼容性依据为该版本所需实验标志及项目最低版本配置，仍需在目标部署版本复核。
- 第 2 项阶段全量 `npm test` 未完成，旧对话集成测试尝试访问本机 HTTP。该接口已在第 3 项迁移为进程内注入。

## 05 第 3 项：HTTP/SSE 与前端切换

- 05 第 3 项已将项目、消息、任务查询/输入/取消、成果读取及 SSE 接入 Fastify；studio.mjs 由 Fastify 提供静态资源并监听本机地址。
- 当前创建项目、编辑项目描述、读写对话消息、读取/取消任务、回放任务 SSE 与按项目读取成果均通过 `/api/v1`。创建消息事务写入 conversation、task、user message 和 `task.started`，同 requestId 同载荷返回原任务，异载荷返回 REQUEST_CONFLICT。终态回复写入 assistant message，`task.succeeded.payload.messageId` 指向完整回复。
- SSE 使用 SQLite 的 event seq 持续读取，回放期间出现的新事件会继续发送；断线时客户端以 afterSeq 补读。终态重复取消返回 HTTP 200；活动取消返回 HTTP 202 并立即显示“正在停止”。
- Fastify 5.12.8 已加入项目依赖并同步锁文件；HTTP/SSE 用 Fastify inject 验证，未启动真实监听端口。
- UI 已切到项目/任务 DTO 与统一活动，移除 `threadId`、`version` 前端字段；活动工具以 callId 更新，折叠状态不因事件变化重置。当前 purpose 仅开放 discuss；system 请求在确认需求能力接入前返回 REQUIREMENTS_UNCONFIRMED。
- 生成交付发布/预览、方案/设置、需求确认、连接管理、附件提取、录制、渲染和审片不属于本项已完成范围；本轮没有启动演示或录屏。

## 已知差距

- 系统生成交付和预览尚未接入新 HTTP 路由；旧 job.json 不迁移。Drizzle、API Key Agent 循环、WorkBuddy 适配器尚未实施。
- Node 类型依赖无法在当前 DNS 受限环境安装，暂以最小 Node API 声明支撑编译；后续联网维护依赖时应改用锁定版本的 `@types/node` 并删除自定义 shim。
- 当前生成输出/交接格式与 docs/examples 的设计契约用途不同，代码未读取该 Schema；后续须显式实现接入，不可直接替换生产数据。
- 需求确认、方案编辑、人工开始录制、真实桌面与完整媒体执行、审片及五类成果归集尚未完整接入。
- 当前 UI 没有源码 ZIP 与预览入口；成果产物发布/保留策略待后续模块实施。
- UI 图片保留作历史视觉参考，可能含旧术语；本轮未重绘，以 02 的文字设计为准。

## 下一步

1. 按 [05 第 5 项](05-实施与验收.md)接入当前方案、脚本与成果服务。完成人工确认范围后再开放 system 目的。
2. 随后依序推进人工录制、媒体与 API Key Agent 模式。各项按 05 的定向验收边界逐步实施。
3. 当前机器已验证 Codex CLI app-server 握手与工作台问候对话；部署到其他目标机时仍需复核 Codex 登录和版本兼容。业务案例、正式演示及录屏由用户负责验收。DNS 可用时再评估 Drizzle 依赖与 lockfile，不重复无效查询。

本机分发是当前设计基线，最终交付形态在部署定稿前确定；外部 Agent 的具体版本、接口能力及商业认证路径在实施前核实。
