# 04 演示方案与执行交接

更新日期：2026-11-26。本文及配套 [Schema](examples/demo-contract.schema.json) 是待实现的数据设计，尚未被当前工作台读取。当前工作台生成输出与录制交接是另一套实现格式，入口见 [代码地图](ARCHITECTURE.md)。

## 契约职责

契约连接“实际系统—演示方案—脚本—执行记录—视频时间轴”。它描述当前项目怎么演示，不提供产品版本管理、运行编号或复杂审批记录。

格式标识 schemaVersion 为 0.3，仅用于区分解析格式，不是项目版本功能。配套文档样例已同步更新；本轮未增加运行代码中的读入器。

| 字段 | 用途 |
|---|---|
| projectId | 当前项目的内部标识。 |
| description | 说明或示例边界。 |
| source | 当前系统来源类型、适配器和入口片段，不含构建版本、源清单或种子摘要。 |
| features | 功能名称、来源、需展示的结果；可关联需求条目。 |
| elements | 本项目的逻辑目标与实际页面定位；标识不是跨项目固定模板。 |
| data | 直接作用于当前项目数据的准备说明、预期初态和可选末态；不包含自由脚本或系统命令。 |
| profile | 开始任务时解析得到的配置值，来自工作台默认配置与项目覆盖；不是每次强制重填。 |
| steps | 本项目所需动作、结果检查、最低展示时间和超时。 |
| narration | 按步骤开始或结果满足的时刻关联讲解。 |
| layers | 桌面、配音、字幕、红框与说明卡的编排信息。 |

两份 [访客预约](examples/visitor-booking.contract.json)、[告警规则](examples/alert-rule.contract.json)是说明性样例，不是首版正式验证案例，也不代表对应页面已在本工作台生成。示例音色、样式、时长和业务值不是用户默认值或通用验收门槛。

## 动作与检查

- 定位支持已有 testId、id、label、精确 text、role + 名称；roleText 在指定角色内按文本匹配。定位由当前源码和页面确认，动态元素写明出现条件。
- 动作目标必须唯一、可见、未被遮挡且焦点正确；检查数量时可以为零或多条，不自动挑第一个。页面改变后重新定位。
- 首批动作设计为观察、真实点击、ASCII 替换输入、限定键盘导航、真实滚轮和刷新。replaceAscii 是已明确范围的输入操作，中文输入支持另作技术细化，不能把中文直接塞入该动作或宣称已经支持。
- 所有业务动作经 PyAutoGUI；CDP 只观察。准备阶段可按项目规则直接初始化文件，录中不通过接口或脚本补写业务结果。
- visible/checked 使用布尔值，count 使用非负整数，value/contains 使用文本。检查根据本项目规则产生，不固定最终行数、阈值或保存动作。
- 超时只允许轮询结果，不重放业务输入。刷新后须确认新文档已加载再检查，避免旧画面误报。错误指出步骤、预期和实测结果。

Schema 只验证形状。实现时另做引用存在、同类 ID 唯一、条件出现、定位有效及业务预期合理性检查。草稿可不完整，进入执行前必须通过必要检查；新动作只能在执行器具备能力后加入。

## 脚本与人工启动

Agent 从当前方案准备脚本，保留目标、输入、检查和运行说明。脚本生成不等于自动开始录制；只有人在工作台点击开始才创建正式执行任务。开始时固定本次方案和有效配置，执行中改草稿不影响当前任务。

data.mode 为 projectData，preparation 描述需要的直接重置或数据准备，initial 描述录前应有状态，final 可选。准备由受控项目适配器实现，不能直接执行 preparation 中的自然语言文本。允许重置数据，不允许借此操作项目外路径或删除交付成果。

## 执行记录与后期交接

执行器输出内部任务关联、步骤标识、开始/结果满足/结束时刻、目标矩形、检查实测和失败原因。媒体交接另包含原片路径与实际时间基准、音频和字幕边界、标注矩形及输出设置；这些运行后信息不回填成方案审批或历史版本。

以原片实际时间与动作事件对齐讲解；结果未确认前不出现“保存成功”等结论。先合成语音并测实长，真实录制中预留对应展示时间。素材不够、定位失败或结果错误时返回问题，不能伪造动作或压缩失败过程冒充成功。

HyperFrames 使用原片、音频、字幕与标注编排，画面等比保留完整桌面、任务栏和鼠标；字幕和卡片避开关键区域。原片保留，纯样式修改可重渲。下面规定执行、采集和媒体交接，不把方案 Schema 当作所有产物格式。

## 草稿、可执行方案与脚本

草稿 body_json 允许缺字段，GET/PUT plan 返回 issues:[{path,code,message}]，path 使用 JSON Pointer。每次保存后重新校验；结构合法并不意味着业务正确。转换为可执行方案时，服务以当前 settings 合并出的 profile 替换草稿旧 profile，校验所有引用，再交脚本编译器。方案的 profile 是可导出的配置快照，日常配置唯一来源仍为 settings。

ScriptPackage 是生成脚本包内的 manifest.json，结构见 [交接 Schema](examples/execution-handoff.schema.json)。一个包固定包含 execute.py、plan.json、preparation.json、manifest.json、README.md 和所需的产品执行模块；execute.py 是产品维护的入口，Agent 提供本项目的声明式方案，不把任意模型 Python 当受信执行程序。下载包可以由用户在已安装 Node/Edge/Python/FFmpeg 的 Windows 环境手动运行，缺依赖时给具体提示，不静默安装。

| ScriptPackage 字段 | 类型与来源 |
|---|---|
| kind / projectId | 固定 script / 项目标识。 |
| sourceArtifactId / planToken | 当前源码与 plan.edit_token；修改方案或替换系统后，原脚本不再直接用于新录制。 |
| entry / planFile / preparationFile | 包内相对路径，分别为 execute.py / plan.json / preparation.json。 |
| supportedActions | 当前执行器支持的动作名列表；不因 Schema 接受某值就宣称执行器已支持。 |

构建脚本前检查：所有 featureId、element id、stepId、旁白与图层引用存在；动作参数符合 Schema；每个业务步骤有结果检查；结果性旁白使用 verified；desktop/voice/captions 各一项，桌面在视觉层最底；box/card 与字幕不重名。出现条件不能只靠一句文本自动执行，应体现在前置动作和 checks；无法推导时保留草稿并提示。

### 数据准备格式

preparation.json 固定为 {mode:"projectData",strategy:"keep"|"seed"|"custom",state?:object|array}，不包含 Shell 或路径。

- keep：保留当前演示数据；方案列明所需状态，准备检查和首步检查不满足就停止，不暗中清空。
- seed：使用当前源码包 seed/state.json 恢复演示状态；格式缺失或不支持时提示，不猜数据文件。
- custom：将经项目适配器校验的 state 写入实际演示状态位置；state 必填。

项目适配器明确拥有状态位置和重置实现，输入只有上述准备意图。生成系统预览用现有数据 API/受控状态文件；正式录制的业务动作仍只走 PyAutoGUI。旧告警样例等非生成格式默认 keep，需用户准备所需状态，不自动导入新产品。

方案 data 增加 resetStrategy 对应 strategy，custom 时 state 必填；preparation/initial/final 保留为人的说明，不当可执行指令。首次默认 keep，用户/方案作者明确设置 seed/custom 后才能重置，不为原数据保护创建额外机制。

## 录制准备与 Worker 协议

Node 启动产品固定 Python 入口，stdin/stdout 为 UTF-8 JSONL，stderr 仅诊断；不得混入普通 print。每个命令含 commandId、taskId、op、payload；一次命令一条 accepted，再产生事件。服务给 Worker 的绝对路径只来自已校验的 artifact/适配器解析，不由模型或浏览器直接指定。

| op | payload | 返回/作用 |
|---|---|---|
| prepare | script manifest、已解析源码/数据位置、plan、effectiveProfile、语音片段引用、capture 输出位置 | 检查依赖、单屏、Edge、焦点、数据、Network、目标校准；返回 ready 和逐项结果，不发正式演示动作。 |
| start | prepare 返回的本次 commandId | 在准备仍有效且用户启动的 record 任务内开启 FFmpeg，确认首帧后执行。 |
| cancel | reason | 立即停止下个动作，封闭已有原片，报告退出；重复取消幂等。 |

Worker 输出 {taskId,seq,type,payload}，seq 为 Worker 本进程序号，由 Node 映射为数据库 Event.seq；两者不能混用。type 为 accepted、ready、step.started、step.verified、step.finished、capture.started、capture.finished、failed、cancelled、heartbeat。Node 将进度转 task.phase；step 事件含 stepId、monotonicMs，verified 另含 checks:[{target,op,expected,actual,passed}]；矩形可用时附 rectPx。只有 capture.finished 且 probe 成功才发布完整原片。

准备时先预合成语音、获取实际音长和字幕边界，再取得桌面锁和初始化数据；失败不进入真实动作。临时通信中断不授权 Worker 自由继续：Node 每秒发 ping，Worker 两秒发 heartbeat；连续 6 秒未见对端消息就停止输入并收尾。这些是实现初始超时，可配置，不是成片质量指标。ping/pong 使用相同包络，op=ping / type=heartbeat，不改变业务状态。

每个项目 Node 服务入口、端口、Edge 进程、目标 URL 和业务 iframe 由项目适配器提供，观察器绑定到唯一目标 frame，而不是顶层所有同名元素。当前生成页的 iframe 与只读沙箱边界保留；CDP 观察能否跨 frame 成功必须在接入时检查。业务输入前获取 frame 内唯一目标的 CSS 矩形，结合实际窗口视口和校准点换算为物理像素，不能仅靠 devicePixelRatio。超出主屏、遮挡、布局移动或前台不符时停止。

源、方案和脚本发布在开始前锁定引用；数据重置不复制源码或建立每次运行副本。应用服务存下计划、profile 和准备参数的本次输入，任务执行期间不读取后来保存的草稿。程序主动切换目标页面只发生在准备阶段；录制中导航、刷新和输入必须是方案内的真实动作。

## 采集结果与时间基准

CaptureManifest 是封闭原片的交接记录，kind=capture；格式同 [交接 Schema](examples/execution-handoff.schema.json)。

| 字段 | 必需内容 |
|---|---|
| projectId / taskId | 当前项目与内部录制任务关联，仅技术标识。 |
| rawArtifactId / scriptArtifactId / sourceArtifactId | 已登记原片、脚本包和源码引用。 |
| complete | 布尔值；false 的记录和 .partial 原片用于排错，不进入正常渲染。 |
| durationMs / widthPx / heightPx | 由原片 ffprobe 读取的时长和实际物理像素尺寸。 |
| timebase | {unit:"ms",origin:"firstVideoFrame",syncSamples:[{monotonicMs,videoMs}]}；至少首尾两个点。 |
| events | {stepId,anchor:"start"|"verified"|"end",atMs,rects?:[{target,rectPx}]}[]，atMs 已转换到原片零点；矩形必须关联具体元素。 |
| checks | {stepId,target,op,expected,actual,passed}[]；实际类型不被转成文本比较。 |
| plan / audio | 实际执行的完整方案快照；音频片段 {narrationId,artifactId,durationMs,cues:[{startMs,endMs,text}]}[]。 |

ready 前语音已测实长，采集开始时记录单调时钟与采集起点配对，封闭后按原片首帧 PTS 修正为 videoMs；配对缺失或不可靠则不标完整。同步样本仅用于映射与误差检查，不以“轮询次数×固定间隔”推算画面。原片以采集到的帧呈现，不能补帧伪造业务结果。

每步最早结束为 max(结果验证完成+holdMs,各旁白实际起点+音长,各标注最低展示结束)，并允许配置阅读尾停。verified 型旁白在结果满足前不出现；同一锚点多段旁白按顺序串联。记录真实开始时间用于后期，不强行把动作拉到预设秒数。用户取消时不得为了播完旁白继续发输入。

## 媒体编译与审片交接

RenderManifest 的 kind=media，projectId、taskId、captureArtifactId、rawArtifactId、profile 为必填；segments 为 {stepId,startMs,endMs,narrationId?,audioArtifactId?,cues,overlays}[]。cues 为原片绝对时间，overlays 为 {type:"box"|"card",startMs,endMs,z,target?,rectPx?,text?,color?,position?}[]。输出包含 timelineArtifactId、projectArtifactId、videoArtifactId；编译前是 null，完成后引用 available 成果。profile 保存本次渲染的有效设置，不改 CaptureManifest.plan。

原片以 artifact.kind=capture 登记；CaptureManifest JSON 另以 kind=media、metadata.subtype=capture_manifest 登记，其 ID 就是 renders.captureArtifactId。时间轴和 HyperFrames 工程分别为 media 的 timeline/hyperframes_project 子类型，RenderManifest 自身用 render_manifest 子类型；最终 MP4 为 kind=video。不能把原片 ID 当作清单 ID。完整 capture 清单含表中全部字段；complete=false 时可缺少尚未采集到的媒体/时间信息，至少保留项目、任务、源码、脚本、方案和失败上下文（失败原因在 Task.error_json）。

渲染任务按 capture 的实际事件把旁白、字幕和标注绑定到原片。box 必须有 target、本步骤该元素的实际 rectPx 和 color，card 必须有 text 和 position；z 取方案对应图层。布局已变而缺少新矩形时拒绝用旧坐标猜。所有时间要求 0≤start<end≤durationMs；字幕无重叠、音频不得截断。完整桌面等比 contain，矩形用相同缩放及留边转换，字幕避开操作与任务栏。

一次渲染生成可重开的 HyperFrames 工程和 H.264/AAC 视频，素材用工程相对引用；源素材和原片不改。ffprobe 验证正时长、音视频流和尺寸后才更新 current_video_id；失败产物不覆盖现有可播放视频。模型不输出任意可执行的后期 HTML，由固定产品模板消费 RenderManifest。

纯字幕/标注样式重渲可以从同一 CaptureManifest 重新编译。旁白文字或音色修改需重新合成并核对实长；原片窗口不足返回 NEEDS_RERECORD，提示人重新录制，不加速或虚构操作。业务动作变化必须重新准备脚本。审片 accepted 绑定 videoArtifactId；只有当前视频可进入 delivered，后来生成的文件自动回到 review。

### 交接检查顺序

Schema 形状 → 所有跨文件/ID 引用 → 时间边界与矩形 → 资源已登记且可用 → 文件实际存在 → Worker 能力与环境。任一步失败，返回 path/stepId、原因和修正位置，不走自由执行降级。样例文件只校验结构和引用，不代表已执行真实业务。
