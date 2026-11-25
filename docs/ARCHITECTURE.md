# 当前架构与代码地图

工作台是本机单进程 Node.js HTTP 服务，提供编译后的 React 页面和任务 API。Codex CLI 作为子进程执行生成，通过 stdio MCP 读取工程技能、需求及允许读取的当前源码。结果由工作台校验、写入任务目录，再通过独立的本机端口提供演示预览。

## 按任务定位

| 要处理的任务 | 首先查看 | 关联入口或验证 |
|---|---|---|
| 工作台界面、需求表单、对话、预览和交接入口 | `src/main.tsx`、`src/style.css` | 根 `index.html`；[工作台设计](02-工作台设计.md) |
| 任务 API、持久化、版本切换、预览、ZIP 和交接 | `server/studio.mjs` 的 `createStudio` | `test/conversation.test.mjs`、`test/studio.test.mjs` |
| Codex 启动、续聊、技能摘要与调用凭据核对 | `server/codex.mjs` 的 `generateWithCodex` | `server/mcp-brief.mjs` 注册 MCP 工具；[技能正文](../.agents/skills/bid-demo-system/SKILL.md) 随工程维护 |
| 输入限制、模型输出结构与页面标识 | `server/spec.mjs` 的 `parseBrief`、`parseGenerated` | `test/generated.test.mjs`；生成输出 Schema 与[拟定的录制契约](04-Demo-Contract.md) 用途不同 |
| 生成系统的运行与数据访问 | `template/generated-server.mjs` 提供沙箱页面与样例、状态 API | `studio.mjs` 将其打包为导出工程的 `server.mjs`；`template/server.mjs`、`demo.mjs`、HTML/CSS 保留旧格式预览 |
| 工作台启动、构建、依赖版本 | `启动工作台.cmd`、`package.json` | `package-lock.json` 锁定依赖，`tsconfig.json` 配置前端类型检查 |

## 状态与数据边界

- **工作台。** `server/studio.mjs` 将任务写入 `.studio/jobs/<任务编号>/job.json`。内存维护任务和预览索引，同一进程一次生成一项。重启会重新读取历史任务，把中断的生成或构建标为失败。
- **生成与交付。** 生成器提供页面、脚本、样例和验收条目；工作台提供固定 Node 服务、打包及启动健康检查。新格式产物在任务目录的 `source/`、`source.zip`，预览数据在独立的 `preview/<标识>/`。导出系统启动后把状态写入自身的 `.runtime/`，保留 `seed/` 初态。
- **架构演进。** 现有后端是 JavaScript ES 模块，元数据使用 JSON 文件。SQLite、录制任务状态机、Python 桌面 Worker、Edge TTS 和 HyperFrames 属于[目标架构](03-技术架构.md)。选择依据与待决问题见 [决策与风险](07-决策与风险.md)。

## 运行与验证

工作台要求 Node.js ≥22.12，前端采用 React 19、TypeScript 5.9 和 Vite 7。真实生成还需本机可调用且已登录的 Codex。以下命令在工程根目录执行。

| 操作 | 命令与预期结果 |
|---|---|
| 安装锁定依赖 | `npm ci` |
| 构建或刷新页面 | `npm run build` 做类型检查并输出 `dist/`。启动脚本只在缺少构建首页时自动构建，修改前端后需重新构建。 |
| 启动工作台 | `npm start`，浏览器打开 `http://127.0.0.1:17860`。Windows 也可双击 `启动工作台.cmd`。 |
| 回归或定向验证 | `npm test` 运行 Node 内置测试。单测文件示例为 `node --test test/generated.test.mjs`。 |
| 验证独立交付物 | 在解压目录运行 `node server.mjs` 或双击 `启动演示.cmd`，新格式默认地址为 `http://127.0.0.1:18080`。 |

工作台端口和数据根目录可用 `DEMO_STUDIO_PORT`、`DEMO_STUDIO_DATA_DIR` 覆盖。验证时将数据根目录指向临时目录。导出系统端口用 `DEMO_PORT` 调整。日常使用步骤见 [README](../README.md)。
