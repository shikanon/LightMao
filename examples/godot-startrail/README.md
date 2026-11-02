# 星光小径

用 Godot 4 标准版打开此目录，运行 `main.tscn`。WASD 或方向键移动，收集五颗星星，R 重新开始。图形通过原生绘制生成，不需要下载素材。

LightMao 中连接工程并单独授权 Godot 后，可选择「导入检查」「运行主场景」或测试脚本 `tests/smoke.gd`。测试覆盖初始状态、移动距离、斜向速度、边界、收集和重置，输出 `lightmao_artifacts/test-results.json`。运行在隔离副本中，产物由引擎运行历史下载。

命令行示例：

```bash
godot --headless --path . --import
godot --headless --path . --quit-after 180 --fixed-fps 60
godot --headless --path . --script res://tests/smoke.gd
```

此样例用于验证引擎与 Agent 的实际链路；自动化测试通过不代表所有玩家体验、设备图形兼容性或发布质量已经验收。
