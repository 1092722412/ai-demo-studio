# 开发状态

更新日期：2026-11-26。05 第 1、2、3 项已实现：统一 AI 类型、Codex app-server 适配器、SQLite Repository，以及项目/对话/任务 HTTP 与 SSE 接口和前端接线。当前 UI 先开放需求讨论和活动展示；确认需求、系统交付/预览、配置、录制与媒体仍按后续实施项推进。

## 当前实现与历史检查

| 事项 | 状态与依据 |
|---|---|
| 新统一 AI 与 app-server 核心 | `server/ai/` 与 `server/tasks.ts` 已由 `server/http.ts`、`server/services/projects.ts` 和 `server/studio.mjs` 接入；会话、消息/工具事件、结果校验、取消、人工输入和 Worker 异常由合成 app-server 用例覆盖。真实 Codex CLI 握手未验证。 |
| 项目/对话/任务 HTTP 与 SSE | `/api/v1` 已支持项目列表/创建/读取/修改、消息读取/提交、任务读取/取消、成果列表/按项目读取。写请求有 Host/Origin/JSON/大小校验；SSE 以持久化 seq 游标补读，断线不取消任务。没有旧 `/api/jobs` 兼容路由。 |
| 前端 | `src/api.ts` 和 `src/useTaskEvents.ts` 使用项目/任务 DTO 与 SSE；移除 threadId/version 依赖，按 callId 更新工具活动并保留折叠状态，取消状态显示“正在停止”。系统确认、交付/预览和录制入口仍待后续实施。 |
| 预览、源码 ZIP、录制交接 | 生成校验器和模板仍保留，但当前入口没有接入产物发布、预览、ZIP、录制或审片路由；历史 `.studio/jobs` 数据不读取、不迁移。 |
| SQLite 存储 | `server/store/` 提供项目、连接、会话/消息、任务/事件/成果的读写查询，事务、requestId 幂等、事件序号、路径隔离、方案/设置比较保存及活动写任务唯一索引。使用 Node 内置 `node:sqlite`，服务启动不扫描历史 `job.json`。 |
| 工程检查 | `npm run build` 通过；定向 AI/TaskService/存储定向测试 19/19，HTTP/SSE/对话/启动定向测试 10/10；全量 `npm test` 通过 31/31。测试用进程内 HTTP 注入和 fake app-server，不申请本机回环端口；未启动真实 Codex、业务演示或录屏。 |
| SQLite/HTTP 依赖 | Node v22.23.2 使用内置 node:sqlite，并以 --experimental-sqlite 运行。Fastify 5.12.8 已登记在 package.json 和 package-lock.json；Drizzle 尚未安装。npm registry 曾不可用，当前实现不依赖 Drizzle。
| Git | 当前分支 main，HEAD 为 3a59d3c7deb63ce085e10f4b6021ddba4c46abb3；工作区保留既存未提交改动。开发期间不主动拉取或同步远程、不切换分支、不清理或覆盖改动；优化完成后按用户确认集中提交一次，不推送。 |

## 本轮文档收敛

- 保留 01–05 作为需求、交互、目标架构、契约和实施计划，删除重复产品索引、独立证据汇编及决策表。文档导航统一到 README，产品决定以 01 为准，技术选择和有效来源以 03 为准。
- 将早期 agent.md 的有效职责、AI 接入、上下文与执行边界并入 03，移除重复架构文件。
- 同步方案 Schema 和两个说明性样例，移除构建版本/源清单/隔离运行目录等字段，放宽初末态为场景描述。样例不是默认验收案例。
- 同步当前代码地图说明、README 与开发约定，修正合并后的读取入口；已有代码、依赖和本机任务数据未改变。
- 详细设计已补齐：03 的适配器签名、Codex app-server 协议映射、API Key 工具循环、数据库字段/约束、配置继承、HTTP/SSE、错误码、状态/互斥/恢复；04 的数据准备、脚本包、Worker 协议、采集及媒体交接；02 的 UI/API 对应；05 的八项开发清单和工程检查点。
- 新增 execution-handoff.schema.json，配套方案增加明确的 resetStrategy。静态文档核对记录见上次状态；本轮开始实施清单第 1 项，并更新了 AI 事件中的 app-server 用户输入问题结构。

- 用户已明确不涉及数据迁移；按新项目初始化数据库，不导入历史 job.json 或提供旧路由兼容。新 Codex 适配器直接使用 app-server，无 exec 回退。

## 本轮实施与验证

- server/http.ts 使用 Fastify 实例注册 /api/v1 路由、安全校验 hook 和 SSE。统一错误映射与项目服务层处理请求，Fastify inject 覆盖生产路由。
- `server/events.ts` 按 SQLite seq 游标持续补读；SSE 收到 Last-Event-ID / afterSeq 时从较大值开始，事件先落库，终态后关闭。客户端使用 Fetch 流解析、断线重连与 seq 去重；工具按 callId 更新，折叠状态保存在组件状态中。
- `server/studio.mjs` 已切换到 SQLite + TaskService + Codex app-server；`npm start` 先构建再以 `--experimental-sqlite` 启动，Windows 启动脚本调用 `npm start`。当前 API/UI 只开放需求讨论；系统生成需先有确认条款，后续模块接入前返回 REQUIREMENTS_UNCONFIRMED。
- 当前成果读取要求 `projectId`，Repository 校验 artifact 的项目归属、相对路径与实际 realpath；写接口校验本机 Host、同源 Origin、JSON 与 1 MiB 请求上限。
- 定向用例 `test/http.test.mjs`、`test/events.test.mjs` 覆盖重复提交、相同 requestId 异载荷冲突、跨项目文件拒绝、回放期间新增事件、断线补读及终态取消幂等。此前悬挂原因是 `node --test` 把 `test/fixtures/fake-codex-app-server.mjs` 当作测试执行；现已移至 `test-support/` 并更新引用。
- 验证通过：`npm run build`；定向 AI/TaskService/存储定向测试 19/19，HTTP/SSE/对话/启动定向测试 10/10；全量 `npm test` 31/31。测试使用进程内 HTTP 注入和合成 app-server，不依赖本机回环端口。`git diff --check` 待最终复查。
- 未实测真实 Codex CLI/app-server 和业务演示；HTTP 监听未启动，接口路由由 Fastify inject 验证。

## 05 第 2 项：类型运行链与 SQLite 初始化

- `server/store/schema.ts` 定义 connection、project、requirement、conversation、message、plan、settings、task、event、artifact、review 及索引；`repository.ts` 通过 SQLite 外键、唯一索引、事务和 edit token 实现目标接口。`saveProject` 同时创建空方案和项目设置。`initializeStore(dataRoot)` 可重复创建空库；启动不扫描历史 `.studio/jobs/**/job.json`。
- 第 2 项阶段采用 Node 内置 `node:sqlite`；Node 22.12 需 `--experimental-sqlite`，因此测试、初始化和当前 `npm start` 均带该标志。`npm run build` 同时构建后端和前端。第 2 项当时 `npm start` 尚未切换；本轮第 3 项已将它改为构建后启动 SQLite 工作台入口。
- 存储验收用例位于 `test/store.test.mjs`：空目录重复初始化、保存后关闭重开、损坏的历史 job.json 不影响初始化、活动写任务唯一执行权、事件序号事务回滚、外键拒绝无效引用、重复 requestId、missing 状态及方案/设置 edit token。存储与第 1 项定向用例合计 19/19 通过；编译后的初始化入口已在临时目录创建 `studio.sqlite`。
- 依赖源 DNS 阻断，Drizzle 无法下载，故本轮使用 Node 内置 SQLite 完成数据层，未更改 `package-lock.json`。当前实际 Node 22.23.2 验证成功；Node 22.12 的实际二进制未安装，兼容性依据为该版本所需实验标志及项目最低版本配置，仍需在目标部署版本复核。
- 第 2 项阶段全量 `npm test` 未完成：旧对话集成测试尝试访问本机 HTTP；其接口已在第 3 项迁移为进程内注入，当前全量结果以本页“本轮实施与验证”为准。

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
- 方案编辑、保存配置、人工开始录制、真实桌面/媒体执行、审片与五类成果归集尚未完整接入。
- 当前 UI 没有源码 ZIP 与预览入口；成果产物发布/保留策略待后续模块实施。
- UI 图片保留作历史视觉参考，可能含旧术语；本轮未重绘，以 02 的文字设计为准。

## 下一步

1. 按 [05 第 4 项](05-实施与验收.md)接入连接/凭据、表现配置和附件提取；尊重用户确认范围后开放 system 目的。
2. 随后依序推进方案脚本、人工录制、媒体与 API Key Agent 模式；各项都按 05 的定向验收边界逐步实施。
3. 在安装并登录目标 Codex CLI 的环境完成协议握手；用户负责案例、演示验收和是否复跑，记录真实环境与结果。DNS 可用时再评估 Drizzle 依赖与 lockfile，不重复无效查询。

本机分发是当前设计基线，最终交付形态在部署定稿前确定；外部 Agent 的具体版本、接口能力及商业认证路径在实施前核实。
