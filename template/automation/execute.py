"""读取并检查脚本包的离线入口。"""
import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
ACTIONS = ("observe", "click", "replaceAscii", "press", "scroll", "refresh")


def read_json(name):
    with (ROOT / name).open(encoding="utf-8") as stream:
        return json.load(stream)


def load_package():
    manifest = read_json("manifest.json")
    plan = read_json("plan.json")
    preparation = read_json("preparation.json")
    if (manifest["kind"] != "script" or manifest["entry"] != "execute.py"
            or manifest["planFile"] != "plan.json" or manifest["preparationFile"] != "preparation.json"
            or manifest["projectId"] != plan["projectId"]
            or tuple(manifest["supportedActions"]) != ACTIONS
            or plan["schemaVersion"] != "0.3"):
        raise ValueError("脚本清单或方案格式不匹配。")
    strategy = preparation["strategy"]
    if (preparation["mode"] != "projectData" or strategy not in ("keep", "seed", "custom")
            or strategy != plan["data"]["resetStrategy"]):
        raise ValueError("数据准备策略不匹配。")
    if strategy == "custom":
        if not isinstance(preparation.get("state"), (dict, list)) or preparation["state"] != plan["data"]["state"]:
            raise ValueError("自定义数据必须与方案状态相符。")
    elif "state" in preparation:
        raise ValueError("当前准备策略不接受自定义数据。")
    if not plan["steps"] or any(action["op"] not in ACTIONS for step in plan["steps"] for action in step["actions"]):
        raise ValueError("步骤为空或含不支持的动作。")
    return manifest, plan


def main():
    parser = argparse.ArgumentParser(description="离线检查 AI Demo Studio 脚本包")
    parser.add_argument("--check", action="store_true", help="检查清单、方案及准备数据")
    if not parser.parse_args().check:
        parser.error("请使用 --check；桌面执行需要工作台的录制 Worker。")
    try:
        manifest, plan = load_package()
    except (OSError, ValueError, KeyError, TypeError) as error:
        print(f"脚本包检查失败：{error}", file=sys.stderr)
        return 1
    print(f"脚本包可读取：{manifest['projectId']}，{len(plan['steps'])} 个步骤。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
