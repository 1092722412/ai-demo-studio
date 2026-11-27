# AI Demo Studio 脚本包

解压后运行 `python execute.py --check`，检查清单、方案和数据准备描述。检查使用 Python 3.10 或更新版本的标准库。

- `manifest.json` 保存当前源码成果和方案 edit token。保存方案或替换源码后，请重新生成脚本。
- `plan.json` 包含项目动作、检查点及生成脚本时的有效配置。
- `preparation.json` 声明保留数据、恢复当前源码的种子状态或准备自定义状态。工作台的项目适配器解析这些数据。
- 正式桌面执行、数据准备写入和录制由工作台的录制 Worker 接手。此版本的入口可离线检查脚本包。
