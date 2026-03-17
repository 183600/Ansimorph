# 🤖 Ansimorph

> AI 幽灵操控你的终端 — LLM 全权控制的 TUI Agent

LLM 决定画面内容、每个按键的行为、鼠标点击响应、是否自动循环、以及刷新频率。

## 安装

```bash
npm install -g ansimorph
```

## 使用

```bash
# 设置 API Key
export OPENAI_API_KEY="sk-xxxx"

# 可选配置
export OPENAI_BASE_URL="https://api.openai.com/v1"
export MODEL="gpt-4o"

# 启动
phanterm
```

## 示例提示词

| 提示词 | 效果 |
|--------|------|
| `做一个贪吃蛇游戏` | 全屏贪吃蛇 |
| `显示一个数字时钟` | ASCII 大字时钟 |
| `交互式文字冒险` | 地牢探险游戏 |

## License

MIT
