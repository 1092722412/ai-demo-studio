AI Demo Studio 的完整架构应该正式收敛为：

**一个独立的 AI Demo Studio 产品 + 一个本地 Agent Harness + 一个跨平台 MCP 接入层 + 一套确定性的桌面自动化与视频生产引擎。**

这里有一个重要调整：我们不应该重新开发一个通用 Agent 平台，而应该利用 Codex、WorkBuddy、DeepSeek Harness 已有的 Agent 能力，把自己的研发重点放在系统演示视频这个垂直领域。

下面是我建议的完整目标架构。

# **一、整体架构全景**

先看全貌。

**用户入口层**

多入口

**AI Demo Studio**

独立 Web 工作台

**外部 AI Harness**

Codex / WorkBuddy / DSH

**平台接入层**

**React Web UI**

直接访问产品

**MCP Server**

跨 Harness 工具协议

**Platform Plugin**

各平台适配

**Agent Skill**

领域操作规范

## **AI Demo Harness**

核心控制层

由我们开发，负责整个演示视频生产任务的运行与控制。

**Agent Runtime Adapter**

接入外部 Agent

**Workflow Engine**

任务编排与状态机

**Context Manager**

项目上下文与契约

**Tool Gateway**

统一工具调用

**Policy Engine**

权限和人工审批

**Resource Manager**

桌面、浏览器资源锁

**State Manager**

状态持久化与恢复

**Observability**

日志、Trace、事件

**本地执行层**

**Project Manager**

源码与项目管理

**Environment Manager**

服务、数据隔离

**Browser Observer**

Playwright / CDP 只读

**Desktop Executor**

PyAutoGUI 真实操作

**Verification Engine**

业务状态验证

**Recording Engine**

FFmpeg 全桌面录屏

**TTS Engine**

Edge TTS 配音

**Video Engine**

HyperFrames 视频制作

**统一数据与产物层**

项目、契约、运行状态、事件、录屏、音频、视频工程、MP4

这个架构包含三个重要主体：

1. 外部 AI Harness 提供智能决策能力。
2. AI Demo Harness 提供专业任务运行与控制能力。
3. AI Demo Studio 提供用户可视化工作台。

这三者不能混为一谈。

# **二、Agent 层：谁负责思考？**

这里我建议第一版不要自己开发完整的大模型推理引擎。

由用户已经使用的 AI 平台负责模型调用和推理。

例如：

| 平台               | 负责的事情               |
| ---------------- | ------------------- |
| Codex            | 理解需求、分析源码、生成代码、调用工具 |
| WorkBuddy        | 同上                  |
| DeepSeek Harness | 同上                  |
| AI Demo Studio   | 管理任务、执行流程、提供专业能力    |

我们自己的 Agent Skill 负责告诉外部 Agent：

- 如何分析一个演示系统。
- 如何生成 Demo Contract。
- 如何设计真实鼠标键盘操作。
- 如何规划讲解和视频时间轴。
- 如何调用本地工具。
- 如何处理失败和重新审核。

### **Agent 的组织方式**

我建议第一版采用 Manager Pattern。

**Manager Agent**

理解用户目标、拆分任务、协调执行、最终验收

**System Designer**

演示系统设计

**Developer Agent**

系统源码开发

**Scenario Designer**

自动化与讲解方案

**Video Designer**

视频编排与标注

但这些不一定需要四个独立运行的 Agent。

第一版可以是一个主 Agent 加四种专业任务角色，只有复杂任务才启用子 Agent。

这样可以减少模型调用成本、上下文同步成本和多 Agent 协作故障。

# **三、Harness 层：产品真正的核心**

这一层是我们必须自己掌握的。

它不负责重新训练模型，而是负责让模型的决策变成可靠的实际任务。

我建议采用 Node.js / TypeScript 作为 Harness 主体。

| 模块                    | 核心职责               |
| --------------------- | ------------------ |
| Agent Runtime Adapter | 对接不同平台的 Agent 工具调用 |
| Workflow Engine       | 管理完整生产流程           |
| Context Manager       | 维护项目、任务、执行上下文      |
| Tool Gateway          | 统一管理工具接口           |
| Policy Engine         | 权限判断、审核与执行约束       |
| Resource Manager      | 桌面、浏览器、录屏进程互斥      |
| State Manager         | 任务状态、检查点、断点恢复      |
| Observability         | 全链路执行日志和追踪         |

其中最重要的是三个模块。

**1. Workflow Engine**

负责：

- 任务拆解。
- 任务依赖。
- 执行顺序。
- 等待人工审核。
- 失败重试。
- 暂停和恢复。

**2. Policy Engine**

负责强制执行安全规则。

例如：

- 未经用户审核，不允许正式录制。
- Playwright 只能读取 DOM，不允许业务点击。
- 所有业务操作必须经过 PyAutoGUI。
- 不允许修改原始项目运行数据。
- 不允许两个任务同时控制桌面。

这些约束不能只写在 Prompt 中。

**3. Resource Manager**

这是我们区别于普通代码 Agent 的地方。

真实 Windows 桌面是一个独占资源。

当录制任务开始：

```
Acquire:
  Windows Desktop
  Edge Demo Browser
  FFmpeg Recorder

Execute:
  Automated Scenario

Release:
  FFmpeg Recorder
  Windows Desktop
  Edge Demo Browser
```

如果另一个 Agent 同时请求控制桌面，必须等待。

# **四、统一契约层：Demo Contract**

这是整个项目最重要的数据设计。

我建议不要让系统开发、操作脚本、视频讲解分别维护独立配置。

而是由一份统一的演示契约作为数据源。

建议分为七个部分：

| 部分                 | 内容               |
| ------------------ | ---------------- |
| Project Spec       | 项目目标、技术栈、环境要求    |
| System Spec        | 功能、前后端、接口和模拟数据   |
| UI Map             | 页面、DOM 稳定标识、元素属性 |
| Execution Scenario | 鼠标键盘操作、步骤和验证条件   |
| Narration Script   | 讲解文案、音频配置        |
| Storyboard         | 分镜、字幕、停顿、时间轴     |
| Visual Overlay     | 红框、说明卡片、标注位置     |

例如：

```
{
  "project": {
    "name": "告警规则演示系统",
    "resolution": "1920x1200"
  },
  "ui_map": [
    {
      "id": "rule.save",
      "selector": "[data-demo-id='rule.save']",
      "role": "button",
      "label": "保存"
    }
  ],
  "scenario": [
    {
      "id": "step_01",
      "action": "click",
      "target": "rule.save",
      "verification": "rule.persisted"
    }
  ],
  "narration": [
    {
      "anchor": "step_01.completed",
      "text": "点击保存，完成告警规则配置。"
    }
  ],
  "overlays": [
    {
      "target": "rule.save",
      "type": "red_border"
    }
  ]
}
```

实际实现中建议把它拆成多个可版本管理的 JSON 文件，而不是维护一个越来越庞大的文件。

### **这份契约的价值**

未来用户要求修改某个功能时：

- 系统源码可以同步修改。
- DOM 标识可以同步修改。
- 自动化脚本可以同步修改。
- 验证规则可以同步修改。
- 讲解和视频时间轴可以同步更新。

这才是我们真正需要的 AI 协同开发能力。

# **五、执行层：如何完成真实操作和视频制作？**

这部分大量复用之前已经验证的 PoC。

**执行工具栈**

**Playwright / CDP**

只读获取 DOM、页面状态、坐标

已验证

**PyAutoGUI**

真实鼠标键盘业务操作

已验证

**FFmpeg**

完整 Windows 桌面录屏，含任务栏

已验证

**Edge TTS**

普通话语音及字幕时间信息

单条讲解已验证

**HyperFrames**

视频工程、时间轴、字幕、红框和说明

基础效果已验证

### **执行过程**

```
创建 Run
   ↓
创建独立运行目录
   ↓
恢复 JSON 初始数据
   ↓
启动 Node 演示服务
   ↓
打开独立 Edge
   ↓
打开 F12 / Network
   ↓
刷新页面，准备请求列表
   ↓
检查浏览器布局和元素坐标
   ↓
用户审核
   ↓
开始 FFmpeg 全桌面录制
   ↓
PyAutoGUI 执行业务操作
   ↓
只读校验每一步结果
   ↓
记录操作事件和时间戳
   ↓
结束录制
   ↓
生成 TTS 和字幕
   ↓
HyperFrames 生成视频工程
   ↓
渲染 MP4
   ↓
视频质量检查
```

这里有三个必须保持的设计原则：

- Network 面板在录制前准备好，录制过程中不再操作。
- 业务操作不允许由 Playwright 或 API 代替。
- 每次运行使用独立数据目录，不污染项目原始 JSON。

另外，讲解与操作采用同步时间轴设计，实际 TTS 时长、操作耗时和必要停顿都要纳入调度，而不是简单把一份 SRT 放在视频上。

# **六、工作台层：用户实际看到什么？**

我建议采用 React + TypeScript，独立运行在本地浏览器。

工作台是产品的主要交互入口，不依赖 Codex 或 WorkBuddy 是否支持嵌入式页面。

## **AI Demo Studio**

工作台概念

**项目中心**

3 个项目

**项目工作区**

**演示设计**

系统功能、操作脚本、讲解方案

**自动化执行**

环境、浏览器、录制、任务进度

**视频制作**

字幕、配音、标注、时间轴

**审核中心**

方案审核、执行审核、成片验收

**最近运行**

**告警规则功能演示**

2026-11-25 · 90 秒

已完成

**网络监控功能演示**

等待方案审核

待审核

工作台主要有六个一级模块：

1. 项目中心。
2. 演示设计。
3. 自动化执行。
4. 视频制作。
5. 审核中心。
6. 素材与产物管理。

不同 Agent 平台中的 MCP UI 只展示任务摘要、审批入口和进度，不承担完整编辑功能。

# **七、MCP 和跨平台插件层**

我们不应该为三个平台分别开发三套业务系统。

建议统一使用 MCP 作为核心工具协议。

**统一 MCP Server**

第一版工具接口建议：

| 工具                     | 功能        |
| ---------------------- | --------- |
| `inspect_project`      | 分析演示项目    |
| `create_demo_contract` | 创建演示契约    |
| `validate_contract`    | 校验方案      |
| `prepare_run`          | 准备运行环境    |
| `request_approval`     | 发起人工审核    |
| `execute_run`          | 执行审核通过的方案 |
| `get_run_status`       | 获取任务进度    |
| `build_video`          | 生成视频      |
| `validate_video`       | 验收成片      |
| `get_artifacts`        | 获取项目产物    |
| `cancel_run`           | 取消任务      |

平台接入顺序：

| 平台               | 第一版策略                          |
| ---------------- | ------------------------------ |
| Codex            | Plugin + Skill + MCP           |
| WorkBuddy        | MCP，条件成熟后做原生 Plugin / MCP Apps |
| DeepSeek Harness | MCP，验证其 UI Host 能力后再适配         |

不要依赖所有平台都支持 MCP Apps。完整工作台始终是独立的。

# **八、数据与存储架构**

这一部分需要区分两个层次。

**第一层：AI Demo Studio 自己的数据。**

它需要保存：

- 项目资料。
- Demo Contract 版本。
- 任务运行状态。
- 审批记录。
- 事件日志。
- 产物索引。

建议采用 SQLite 保存结构化元数据，JSON 文件保存契约，JSONL 保存执行事件，媒体文件独立存储。

**第二层：被演示系统的数据。**

仍然遵循之前的设计：

- 不使用数据库。
- JSON 作为模拟业务数据。
- 每次录制使用独立的 runtime data 目录。
- 每次运行从固定初始样例恢复。
- 原始项目数据只读保护。

两套数据不能混在一起。

建议的目录：

```
AI-Demo-Studio/
│
├── apps/
│   ├── studio-web/             # React 工作台
│   ├── control-server/         # Node.js 控制服务
│   └── mcp-server/             # MCP 接入
│
├── packages/
│   ├── demo-contract/          # 契约 Schema
│   ├── workflow-engine/        # 流程引擎
│   ├── tool-gateway/           # 工具网关
│   ├── policy-engine/          # 权限审批
│   └── shared-types/           # 类型定义
│
├── workers/
│   ├── desktop-worker/         # Python + PyAutoGUI
│   ├── browser-observer/       # DOM 只读
│   ├── recorder/               # FFmpeg
│   ├── tts/                    # Edge TTS
│   └── video-worker/            # HyperFrames
│
├── adapters/
│   ├── codex/
│   ├── workbuddy/
│   └── deepseek/
│
├── skills/
│   └── demo-production/
│
├── storage/
│   ├── studio.db
│   ├── projects/
│   └── runs/
│
└── docs/
    ├── PRD.md
    ├── ARCHITECTURE.md
    ├── DEMO-CONTRACT.md
    └── MVP-PLAN.md
```

这是目标工程结构，不意味着第一版需要一次性创建所有模块。

# **九、任务运行状态机**

Harness 必须有明确的状态机，不能依赖 Agent 的对话记忆。

我建议：

**DRAFT**

1/8

方案生成中

**REVIEW**

2/8

等待用户审核

**PREPARING**

3/8

准备环境

**READY**

4/8

环境检查通过

**RECORDING**

5/8

正在真实操作和录制

**POST_PROCESSING**

6/8

配音与视频制作

**VALIDATING**

7/8

成片质量检查

**COMPLETED**

8/8

交付完成

FAILED

任一阶段发生不可恢复错误

PAUSED

人工暂停或等待处理

RECOVERY

重新检查现场状态后恢复

尤其注意：录制失败不能简单从上一个鼠标点击继续。必须重新检查页面、业务数据和执行现场，防止重复操作。

# **十、最终技术选型**

这是我建议的第一版技术栈。

| 层次         | 技术                   |
| ---------- | -------------------- |
| 工作台        | React + TypeScript   |
| 本地后端       | Node.js + TypeScript |
| Agent 接入   | MCP SDK              |
| Agent 运行时  | 优先复用外部 Harness       |
| 契约规范       | JSON Schema          |
| 任务调度       | 自研轻量 Workflow Engine |
| 元数据存储      | SQLite               |
| 事件记录       | JSONL                |
| 桌面执行       | Python + PyAutoGUI   |
| 页面观察       | Playwright + CDP     |
| 演示服务       | Node.js              |
| 录屏         | FFmpeg               |
| 配音         | Edge TTS             |
| 视频工程       | HyperFrames          |
| Windows 分发 | 安装器 + 用户会话后台 Runtime |

这里暂时不建议引入 LangGraph、CrewAI、AutoGen 等完整多 Agent 框架。第一版没有必要再引入一套任务调度和状态管理体系。

# **十一、哪些已经确定，哪些还不能算确定？**

这点很重要。架构图画出来不等于所有技术风险都解决了。

**已经验证或明确选择**

已确认

- Windows 本地真实桌面操作。
- Playwright 只读 DOM。
- PyAutoGUI 真实鼠标键盘。
- FFmpeg 全桌面录屏。
- F12 / Network 录制前准备。
- JSON 独立运行目录。
- Edge TTS 基础配音。
- HyperFrames 基础后期效果。
- 用户审核驱动的录制流程。

  **仍需工程验证**

  待验证
- Harness 异步任务及断点恢复。
- 连续多次录制的稳定性。
- 不同 DPI、分辨率和多显示器适配。
- 长视频、多段语音同步。
- HyperFrames 长视频渲染性能。
- MCP 与工作台审批状态同步。
- Codex、WorkBuddy、DeepSeek 的实际 UI 嵌入兼容性。
- Windows 安装、升级和依赖管理。

# **十二、我建议最终按什么顺序开发？**

不要一次性实现整张架构图。

建议拆成四个里程碑：

| 里程碑 | 核心目标    | 交付                              |
| --- | ------- | ------------------------------- |
| M1  | 产品骨架    | Web 工作台、Runtime、SQLite、MCP、任务状态 |
| M2  | 自动化生产   | 接入现有 PoC，完成真实操作和视频生产            |
| M3  | AI 协同设计 | Demo Contract、源码分析、方案生成、审核      |
| M4  | 产品化与生态  | Codex 插件、WorkBuddy/DSH 适配、安装器   |

这里我特意把 M2 和 M3 的顺序安排成先验证执行，再完善 AI 生成。

因为已有 PoC 已经证明执行闭环可行，但 AI 自动生成 Contract 还没有验证。我们不应该让一个未经验证的 AI 生成能力成为整个产品的基础。

## **最终的架构判断**

我想特别强调三个设计原则：

**第一，外部 Harness 不等于我们的 Harness。**

Codex、WorkBuddy、DeepSeek 负责模型推理和通用 Agent 能力；我们负责专业工作流、任务状态、权限控制和真实桌面执行。

**第二，Demo Contract 是整个生产链路的中心。**

系统源码、自动化步骤、验证条件、讲解、字幕和视频标注必须有统一的数据依据。

**第三，确定性执行优先于 Agent 自由发挥。**

AI 可以分析、设计、生成和诊断，但真正操作 Windows、恢复数据、录制和渲染，必须由固定执行器完成。

我的建议是以这套架构作为后续设计的 V1 基线。下一步不是马上编码，而是把它细化成模块接口、数据库模型、MCP 工具 Schema、状态机转换规则和 Demo Contract 完整 Schema，形成 Codex 可以直接执行的工程设计依据。