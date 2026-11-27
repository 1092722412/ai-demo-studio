# 开发状态

更新日期为 2026-11-26。第 6 项已接通工作台人工启动、录前语音、Windows 桌面 Worker、步骤记录和原片交接。工程验证使用合成项目和替身，真实录制由用户验收。媒体编译、后期和审片列入第 7 项。

## 05 第 6 项 人工启动和桌面执行

- 工作台显示生效设置与准备策略，由用户点击「开始录制」。同源 POST 复核当前方案令牌、脚本与源码归属和可用性，以及确认范围与音色配置。录制快照固定后先准备讲解和字幕时间，合成完成后才申请桌面。准备结束后由固定 Worker 打开 Edge。启动与运行依赖见 [代码地图](ARCHITECTURE.md)。
- 任务通过 Worker JSONL 记录准备状态、采集首帧、步骤实测与结束时间。完整原片和 `CaptureManifest` 一起发布。取消、失联、失败和重启的遗留原片标为 partial，仅可显式下载。重启先等待所记录的旧 Worker 退出，再标记 interrupted。用户须手动发起新录制。
- 工程验证通过。录制、交接、HTTP/SSE、方案、设置、脚本、成果、预览和源码发布的定向测试 55/55，`npm test` 86/86，`npm run build` 和 `git diff --check` 通过。Python 3.12.14 运行 `-B -m unittest discover -s workers/desktop` 通过 9/9。工程测试使用临时目录、合成数据、Fastify inject、假 Worker 和替身媒体探测。预览用例使用本机回环临时端口。
- 过程失败已修复。测试先复现了录制路由缺失、假 Worker 终态后仍等待 stdin、数据根缺少实例锁、刷新后可读到旧文档，以及步骤校验错误被协议层统一归类；最终复跑无失败。
- 跨项目的桌面争用在语音准备后由任务报告 `RESOURCE_BUSY`。重启用 PID 和任务标记排除进程号复用。Windows 进程查询无法确认归属时，服务保留桌面占用。
- 尚待用户验收 Windows 会话桌面互斥、任务栏与 Network、Edge 沙箱 iframe 的观察、物理坐标与 PyAutoGUI 输入、停止热键、真实 FFmpeg/ffprobe 采集对时、edge-tts 联网和原片播放，以及业务流程。上轮真实浏览器交互与 Codex 方案生成也仍待验收。

## 录制准备工作台

- 工作台使用 `purpose=plan` 请求 Codex 提案。用户载入后可阅读步骤、输入与检查，编辑方案 JSON 和选中的讲解。草稿允许字段缺失，显式保存后更新当前方案，并显示字段校验及待更新状态。保存使用 If-Match，409 时保留本地编辑并读取服务端版本供对照。当前页面会话按项目保留未保存草稿和最近发起的提案任务 ID，切换项目后重新核对保存基线。
- 试听提交所选讲解文本，复用任务事件和成果读取，显示进度、失败原因及音频控制。缺音色时可进入设置。脚本包按已保存的方案生成，下载时核对当前方案令牌和源码 ID，旧包显示已失效。界面和测试入口见 [代码地图](ARCHITECTURE.md)。
- 通过：新增 `test/handoff.test.mjs` 1/1，含方案、设置、脚本、成果、AI 适配器、源码发布和预览的定向测试 48/48，`npm test` 74/74，`npm run build`、`git diff --check`。使用临时目录、合成源码与方案、Fastify inject、注入的 AI 适配器和语音服务。测试覆盖显式保存、草稿冲突、项目文件隔离、缺音色、合成失败、音频读取、ZIP 下载及源码替换失效。
- 失败及复跑：新增链路用例在接入客户端 API 前因缺少 `getPlan` 失败，接入后通过。受限沙箱的首次定向运行有 10 个依赖本机回环的预览用例失败，获准使用回环临时端口后定向和全量复跑均通过。
- 未验证：真实浏览器点击、项目切换和冲突对照交互、iframe 交互、真实 Codex 方案生成、edge-tts 联网与音频播放、业务演示验收。当前工作区保留既有改动和本轮变更，HEAD 为 `9676072`。

## 当前源码预览

- 工作台「打开预览」调用 POST `/api/v1/projects/:id/preview`，将健康检查通过的本机地址载入沙箱 iframe。预览读取 `currentSourceId` 指向的可用 ZIP，按文件布局复用固定生成模板或旧版录入模板。每个项目的当前源码复用一个预览会话，试用数据保存在独立临时目录。预览操作只读项目与方案状态。实现和测试入口见 [代码地图](ARCHITECTURE.md)。
- 通过：`test/preview.test.mjs` 9/9，含源码发布、HTTP/SSE、方案、脚本和成果的定向测试 39/39，`npm test` 73/73，`npm run build`、`git diff --check` 通过。使用临时目录、合成源码和 Fastify inject。预览服务及关闭测试绑定真实回环临时端口，验证了成功与并发复用、旧格式、跨项目和不可用源码、启动及健康检查失败、源码发布替换、启动期间替换和工作台关闭清理。
- 最终复跑无失败。常规命令沙箱的回环连接返回 EACCES，获准后在本机回环重跑。回归用例也复现了 ZIP 截断后复用旧预览和活动 SSE 阻塞工作台关闭，修正后通过。
- 未验证真实浏览器点击与 iframe 交互、Windows 控制台信号关闭、真实 Codex 生成、独立交付物启动及业务验收。桌面操作与录屏留给用户。

## 人工确认、系统生成与源码发布

- 工作台可编辑条款、载入 Codex 提案并逐项确认。确认写入 SQLite，保存用 If-Match 复核。修改项目需求描述撤销全部确认，修改既有条款的正文、预期结果或出处撤销对应确认。范围变化使已有方案待更新。全部确认后开放 `system` 任务。
- 生成任务通过既有校验器和固定 Node 模板构建源码 ZIP。成果发布、当前源码指针、方案失效与成功终态同事务提交。模型或构建失败、发布失败、取消和中断时保留原指针。重启把中断任务标为 interrupted，遗留 ZIP 按实际文件归为 partial 或 missing。入口见 [代码地图](ARCHITECTURE.md)。
- 通过：`test/system-publication.test.mjs` 11/11，连同 AI 适配器、第 5 项及工作台入口的定向测试 35/35，`npm test` 63/63，`npm run build`、`node --check template/generated-server.mjs` 和 `git diff --check` 通过。测试使用临时目录、合成 app-server 及 Fastify inject，覆盖确认门槛、失效、失败与取消保留、重启收尾及新源码进入方案和脚本流程。
- 最终复跑无失败。首轮因确认路由尚未接入而失败，随后修正了发布失败用例的旧成果夹具和脚本设置。重启、构建取消和初态字节限制的回归用例在对应实现前均复现了缺口。
- 上轮未实测真实 Codex 生成、浏览器交互、真实 HTTP 监听或独立源码启动。当前预览的回环验证见上节。

## 05 第 5 项 当前方案、脚本与成果服务

- 当前方案可用 If-Match 保存不完整草稿，返回 JSON Pointer 校验问题。Codex `plan` 使用原生 `{reply,draftJson}` Schema，服务端将草稿提案放入任务结果，用户经方案保存接口写入当前草稿。调整需求范围或替换当前源码会更新编辑令牌。
- 脚本任务核对方案结构、步骤和图层引用、已确认条款、当前源码 ZIP 及数据准备策略，使用生效设置生成包含清单、固定入口、说明和依赖清单的 ZIP。旧脚本在方案编辑或源码替换后标记 stale。固定 Python 入口提供离线检查。正式桌面执行由第 6 项 Worker 接手。
- 成果读写按项目隔离。发布失败或取消保留原当前指针，视频支持流式单段 Range，部分成果可显式下载。中断的静态脚本任务在服务启动时标记 interrupted，未完成文件归为 partial 或 missing。
- 第 5 项交接时用合成 ZIP 验证成果发布。人工确认与系统结果到源码 ZIP 的接入记录见上节。
- 工程验证通过：`node --experimental-sqlite --test test/plans.test.mjs test/scripts.test.mjs test/artifacts.test.mjs` 10/10，含合成 app-server 的扩展定向用例 23/23，`npm test` 52/52，`npm run build`、`git diff --check` 通过。Python 3.12.14 运行合成包的 `execute.py --check` 成功，并拒绝了不一致的准备文件。
- 过程失败已收尾：锁定镜像下载超时后使用 npm 官方源安装同一锁定版本。首轮 Schema 相对引用解析及合成源码测试夹具失败，修正后复跑无失败。
- 本轮未验证真实 Codex CLI/app-server、Windows 凭据管理器、edge-tts 联网、浏览器、真实 HTTP 监听、业务演示和录屏。测试使用临时目录、合成数据、Fastify inject 及合成 app-server。历史启动验证见下文。

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
| 项目/对话/任务 HTTP 与 SSE | `/api/v1` 支持项目、确认条款、消息、任务、当前方案、脚本生成、人工录制、成果读写和当前源码预览。写请求有 Host/Origin/JSON/大小校验，SSE 以持久化 seq 游标补读。 |
| 前端 | 项目页支持讨论、材料提取、确认条款、系统生成和当前源码预览及下载。「录制与审片」支持方案、试听、脚本包、人工录制、停止与原片交付。`src/SettingsPanel.tsx` 显示全局/项目配置、生效来源、保存冲突与 Codex 探测。 |
| 设置、连接与材料 | 工作台入口、依赖、数据边界和接口详见 [代码地图](ARCHITECTURE.md)。默认、全局、项目按叶继承，If-Match 冲突保护，凭据由独立适配器处理。附件保留原件，TXT/Markdown/JSON/CSV、PDF 和 DOCX 按原文位置建立引用。 |
| 预览、源码 ZIP、录制交接 | 当前系统源码 ZIP 可生成、预览并下载，方案和脚本包可在工作台准备。人工录制交付原片及采集清单，媒体编译和审片待接入。历史 `.studio/jobs` 数据不迁移。 |
| SQLite 存储 | `server/store/` 提供项目、连接、会话/消息、任务/事件/成果的读写查询，事务、requestId 幂等、事件序号、路径隔离、方案/设置比较保存及活动写任务唯一索引。使用 Node 内置 `node:sqlite`，服务启动不扫描历史 `job.json`。 |
| SQLite 与依赖 | 使用内置 node:sqlite，以 `--experimental-sqlite` 运行。本轮验证使用 Node v24.12.0，历史验证使用 Node v22.23.2。第 5 项将现有间接依赖 Ajv 8.20.0 声明为直接依赖，用于校验草稿与脚本。Drizzle 尚未安装。 |
| Git | 第 5、6 项与人工确认、源码发布、预览的累计改动作为同一批次提交到 `master`。`9676072` 是本批次的基线，包含第 4 项和 Windows 启动修复。 |

## 05 第 4 项：设置、连接、凭据与附件

- 设置 API 输出保存值、生效值、逐叶来源和 editToken/ETag。项目值缺省时继承全局，null 移除覆盖。If-Match 缺失返回 428，版本冲突返回 409。缺音色只阻止音频准备。
- 提供连接列出、创建、修改、删除凭据和探测。Windows 实现使用当前用户的凭据管理器。替换凭据时先写新项，数据库失败时删除新项，数据库更新成功后清理旧项。通过假存储核对 HTTP、SSE 和 SQLite 正文未包含密钥。
- 通过 multipart 上传材料。原件按项目隔离，提取在独立任务中记录。PDF 使用真实页码，DOCX 使用提取段落号，其他支持格式保留原文行号。扫描 PDF 无可读文本时任务报错并保留原件。
- Codex `requirements` 使用独立原生 Schema。服务器校验原文引用来自本轮读取的附件片段，交付条目保持待人工确认。
- 试听端点在开始时保存生效配置快照，产出独立音频任务，无桌面依赖。已用注入合成器覆盖配置快照、失败收尾及其他项目可继续操作。讲解选择和试听界面见「录制准备工作台」。
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

- Drizzle、API Key Agent 循环、WorkBuddy 适配器尚未实施。
- Node 类型依赖无法在当前 DNS 受限环境安装，暂以最小 Node API 声明支撑编译；后续联网维护依赖时应改用锁定版本的 `@types/node` 并删除自定义 shim。
- 系统生成输出和演示方案使用不同契约。当前方案与脚本已读取 docs/examples 中的 Schema；采集和媒体交接仍需接入。
- 方案编辑与试听 UI、人工开始录制、正式桌面执行、完整媒体执行、审片及五类成果归集尚待接入。
- UI 图片保留作历史视觉参考，可能含旧术语；本轮未重绘，以 02 的文字设计为准。

## 下一步

1. 在「录制与审片」接入方案提案、草稿编辑、选中讲解试听和脚本包下载，复用已有方案、脚本和试听服务。
2. 随后依序推进人工录制、媒体与 API Key Agent 模式。各项按 05 的定向验收边界逐步实施。
3. 当前机器已验证 Codex CLI app-server 握手与工作台问候对话；部署到其他目标机时仍需复核 Codex 登录和版本兼容。业务案例、正式演示及录屏由用户负责验收。DNS 可用时再评估 Drizzle 依赖与 lockfile，不重复无效查询。

本机分发是当前设计基线，最终交付形态在部署定稿前确定；外部 Agent 的具体版本、接口能力及商业认证路径在实施前核实。
