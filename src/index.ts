#!/usr/bin/env node

/**
 * ╔══════════════════════════════════════════════════════════╗
 * ║  TUI Agent — LLM 全权控制的终端界面代理                    ║
 * ║                                                          ║
 * ║  LLM 决定:                                               ║
 * ║    1. 终端画面内容（填满整个屏幕）                           ║
 * ║    2. 每个键盘按键对应的下一步提示词                         ║
 * ║    3. 鼠标点击对应的下一步提示词                             ║
 * ║    4. 是否自动循环、循环提示词、刷新延时下限                   ║
 * ╚══════════════════════════════════════════════════════════╝
 */

import * as readline from "node:readline";

// ═══════════════════════════════════════════════════════════
//  类型定义
// ═══════════════════════════════════════════════════════════

/** LLM 返回的结构化响应 */
interface LLMResponse {
  /** 填满终端的屏幕内容（用 \n 换行，可含 ANSI 颜色码） */
  screen: string;
  /** 键盘绑定：按键名 → 对应的提示词（"__quit__" 退出，"__noop__" 忽略） */
  keyBindings: Record<string, string>;
  /** 鼠标点击提示词模板，{{x}} {{y}} 会被替换为坐标 */
  mouseAction: string;
  /** 是否自动循环 */
  loop: boolean;
  /** 循环时的下一个提示词 */
  nextPrompt?: string;
  /** 画面更新延时下限（毫秒，最低 100） */
  minDelay: number;
}

/** Agent 运行时状态 */
interface AgentState {
  running: boolean;
  currentResponse: LLMResponse | null;
  loopTimer: ReturnType<typeof setTimeout> | null;
  processing: boolean;
  pendingPrompt: string | null;
}

// ═══════════════════════════════════════════════════════════
//  终端控制层
// ═══════════════════════════════════════════════════════════

const term = {
  get cols(): number {
    return process.stdout.columns || 80;
  },
  get rows(): number {
    return process.stdout.rows || 24;
  },

  write(s: string): void {
    process.stdout.write(s);
  },

  // —— ANSI 控制 ——
  clear(): void {
    this.write("\x1b[2J\x1b[H");
  },
  hideCursor(): void {
    this.write("\x1b[?25l");
  },
  showCursor(): void {
    this.write("\x1b[?25h");
  },
  enterAltScreen(): void {
    this.write("\x1b[?1049h");
  },
  exitAltScreen(): void {
    this.write("\x1b[?1049l");
  },
  enableMouseTracking(): void {
    // 开启按钮事件 + SGR 扩展坐标模式
    this.write("\x1b[?1000h\x1b[?1002h\x1b[?1006h");
  },
  disableMouseTracking(): void {
    this.write("\x1b[?1006l\x1b[?1002l\x1b[?1000l");
  },
  moveTo(row: number, col: number): void {
    this.write(`\x1b[${row};${col}H`);
  },
  resetStyle(): void {
    this.write("\x1b[0m");
  },

  // —— 屏幕渲染 ——
  fillScreen(content: string): void {
    this.clear();
    const lines = content.split("\n");
    const maxLines = this.rows;
    for (let i = 0; i < maxLines; i++) {
      this.moveTo(i + 1, 1);
      if (i < lines.length) {
        this.write(lines[i]);
      }
    }
    this.resetStyle();
  },

  // —— 模式切换 ——
  setup(): void {
    this.enterAltScreen();
    this.clear();
    this.hideCursor();
    this.enableMouseTracking();
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true);
    }
    process.stdin.resume();
    process.stdin.setEncoding("utf-8"); // 不设 encoding，保持 Buffer
  },

  teardown(): void {
    this.resetStyle();
    this.disableMouseTracking();
    this.showCursor();
    this.exitAltScreen();
    if (process.stdin.isTTY) {
      try {
        process.stdin.setRawMode(false);
      } catch {
        /* 忽略 */
      }
    }
    try {
      process.stdin.pause();
    } catch {
      /* 忽略 */
    }
  },
};

// ═══════════════════════════════════════════════════════════
//  输入解析（键盘 + 鼠标）
// ═══════════════════════════════════════════════════════════

/** 将原始 Buffer 解析为按键名称 */
function parseKeyName(buf: Buffer): string | null {
  const str = buf.toString("utf-8");

  // 排除鼠标序列
  if (str.includes("\x1b[<") || str.includes("\x1b[M")) return null;

  // 单字节
  if (buf.length === 1) {
    const b = buf[0];
    const map: Record<number, string> = {
      3: "ctrl+c",
      4: "ctrl+d",
      9: "tab",
      10: "enter",
      13: "enter",
      27: "escape",
      32: "space",
      127: "backspace",
      8: "backspace",
    };
    if (map[b]) return map[b];
    if (b >= 1 && b <= 26) return `ctrl+${String.fromCharCode(b + 96)}`;
    if (b >= 33 && b < 127) return String.fromCharCode(b);
    return null;
  }

  // 多字节转义序列
  const escMap: Record<string, string> = {
    "\x1b[A": "up",
    "\x1b[B": "down",
    "\x1b[C": "right",
    "\x1b[D": "left",
    "\x1b[H": "home",
    "\x1b[F": "end",
    "\x1b[2~": "insert",
    "\x1b[3~": "delete",
    "\x1b[5~": "pageup",
    "\x1b[6~": "pagedown",
    "\x1b[11~": "f1",
    "\x1bOP": "f1",
    "\x1b[12~": "f2",
    "\x1bOQ": "f2",
    "\x1b[13~": "f3",
    "\x1bOR": "f3",
    "\x1b[14~": "f4",
    "\x1bOS": "f4",
    "\x1b[15~": "f5",
    "\x1b[17~": "f6",
    "\x1b[18~": "f7",
    "\x1b[19~": "f8",
    "\x1b[20~": "f9",
    "\x1b[21~": "f10",
    "\x1b[23~": "f11",
    "\x1b[24~": "f12",
  };
  if (escMap[str]) return escMap[str];

  // UTF-8 单字符
  if (!str.startsWith("\x1b") && [...str].length === 1) return str;

  return null;
}

interface MouseEvent {
  x: number;
  y: number;
  button: number;
  type: "press" | "release" | "move";
}

/** 解析 SGR 鼠标事件 */
function parseMouseEvent(buf: Buffer): MouseEvent | null {
  const str = buf.toString("utf-8");
  // SGR 格式: \x1b[<Btn;X;Y[Mm]
  const m = str.match(/\x1b\[<(\d+);(\d+);(\d+)([Mm])/);
  if (!m) return null;
  const btnFlags = parseInt(m[1]);
  return {
    x: parseInt(m[2]),
    y: parseInt(m[3]),
    button: btnFlags & 3, // 0=左键, 1=中键, 2=右键
    type: m[4] === "m" ? "release" : btnFlags & 32 ? "move" : "press",
  };
}

// ═══════════════════════════════════════════════════════════
//  LLM 接口层
// ═══════════════════════════════════════════════════════════

/** 构建系统提示词——指示 LLM 输出格式 */
function buildSystemPrompt(): string {
  const c = term.cols;
  const r = term.rows;

  return `You are a TUI (Terminal User Interface) agent. You fully control a terminal of ${c} columns × ${r} rows.

═══ OUTPUT FORMAT (strict JSON, no markdown fence) ═══

{
  "screen": "<string: the FULL screen content, ${r} lines separated by literal newline characters, each line up to ${c} chars>",
  "keyBindings": {
    "<key_name>": "<prompt_or_command>",
    ...
  },
  "mouseAction": "<prompt template; use {{x}} and {{y}} for click coords; empty string = no mouse>",
  "loop": <boolean: true to auto-continue>,
  "nextPrompt": "<string: prompt for next iteration, required if loop=true>",
  "minDelay": <number: ms before next frame, minimum 100>
}

═══ KEY NAMES ═══
Letters: a-z | Digits: 0-9 | Special: enter, space, escape, tab, backspace
Arrows: up, down, left, right | Navigation: home, end, pageup, pagedown
Function: f1-f12 | Combos: ctrl+c, ctrl+d, ctrl+l, etc.

═══ SPECIAL BINDING VALUES ═══
"__quit__" → exit program immediately
"__noop__" → do nothing

═══ RULES ═══
1. ALWAYS include at least one exit binding (e.g. "q":"__quit__" or "escape":"__quit__")
2. Screen MUST have exactly ${r} lines (pad with empty lines if needed)
3. For colors use ANSI: \\x1b[31m=red \\x1b[32m=green \\x1b[33m=yellow \\x1b[34m=blue \\x1b[35m=magenta \\x1b[36m=cyan \\x1b[1m=bold \\x1b[0m=reset \\x1b[7m=reverse
4. Use Unicode box drawing: ┌─┐│└┘├┤┬┴┼ ═║╔╗╚╝╠╣╦╩╬ ░▒▓█ ◆●○■□▶◀▲▼
5. Last 1-2 lines should be a status/help bar showing available keys
6. Be CREATIVE: make beautiful, functional TUI apps
7. When loop=true, design frames for smooth animation/updates
8. Respond with RAW JSON only — no markdown code fences, no explanation

You can build ANYTHING: games, dashboards, menus, pixel art, animations, clocks, interactive fiction, file browsers, calculators, music visualizers — whatever the user asks for.`;
}

/** 将 LLM 输出中的转义序列还原为真实字符 */
function unescapeScreen(raw: string): string {
  return raw
    .replace(/\\x1b/gi, "\x1b")
    .replace(/\\u001[bB]/g, "\x1b")
    .replace(/\\033/g, "\x1b")
    .replace(/\\e\[/g, "\x1b[");
}

/** 从 LLM 响应文本中提取 JSON */
function extractJSON(text: string): string {
  // 优先尝试去掉 markdown 代码围栏
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) text = fenced[1].trim();

  // 找到最外层的 { ... }
  let depth = 0;
  let start = -1;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (text[i] === "}") {
      depth--;
      if (depth === 0 && start !== -1) {
        return text.slice(start, i + 1);
      }
    }
  }
  return text;
}

/** 调用 LLM API */
async function callLLM(
  prompt: string,
  history: Array<{ role: string; content: string }>,
  signal?: AbortSignal
): Promise<LLMResponse> {
  const apiKey = process.env.OPENAI_API_KEY || process.env.API_KEY || "";
  const baseUrl = (
    process.env.OPENAI_BASE_URL ||
    process.env.BASE_URL ||
    "https://api.openai.com/v1"
  ).replace(/\/+$/, "");
  const model = process.env.MODEL || "gpt-4o";

  if (!apiKey) {
    throw new Error(
      "请设置环境变量 OPENAI_API_KEY（或 API_KEY）"
    );
  }

  const messages = [
    { role: "system", content: buildSystemPrompt() },
    ...history.slice(-20), // 保留最近的上下文
    { role: "user", content: prompt },
  ];

  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages,
      temperature: 0.7,
      max_tokens: 4096,
    }),
    signal,
  });

  if (!res.ok) {
    const errBody = await res.text().catch(() => "");
    throw new Error(`API 错误 ${res.status}: ${errBody.slice(0, 200)}`);
  }

  const data: any = await res.json();
  const content: string = data.choices?.[0]?.message?.content ?? "";
  if (!content.trim()) throw new Error("LLM 返回空内容");

  const jsonStr = extractJSON(content);

  try {
    const p = JSON.parse(jsonStr);
    return {
      screen: typeof p.screen === "string" ? p.screen : "No screen content",
      keyBindings:
        typeof p.keyBindings === "object" && p.keyBindings
          ? p.keyBindings
          : { q: "__quit__" },
      mouseAction: typeof p.mouseAction === "string" ? p.mouseAction : "",
      loop: !!p.loop,
      nextPrompt: typeof p.nextPrompt === "string" ? p.nextPrompt : "",
      minDelay: Math.max(Number(p.minDelay) || 1000, 100),
    };
  } catch {
    // JSON 解析失败，将原始内容作为屏幕展示
    return {
      screen: content.slice(0, term.rows * (term.cols + 1)),
      keyBindings: { q: "__quit__", escape: "__quit__", r: prompt },
      mouseAction: "",
      loop: false,
      nextPrompt: "",
      minDelay: 1000,
    };
  }
}

// ═══════════════════════════════════════════════════════════
//  加载动画
// ═══════════════════════════════════════════════════════════

class LoadingSpinner {
  private interval: ReturnType<typeof setInterval> | null = null;
  private frame = 0;

  private static readonly FRAMES = [
    "⠋",
    "⠙",
    "⠹",
    "⠸",
    "⠼",
    "⠴",
    "⠦",
    "⠧",
    "⠇",
    "⠏",
  ];

  private static readonly MESSAGES = [
    "Thinking",
    "Generating",
    "Crafting",
    "Rendering",
    "Computing",
  ];

  start(): void {
    const msg =
      LoadingSpinner.MESSAGES[
        Math.floor(Math.random() * LoadingSpinner.MESSAGES.length)
      ];
    this.frame = 0;

    this.interval = setInterval(() => {
      const sp = LoadingSpinner.FRAMES[this.frame % LoadingSpinner.FRAMES.length];
      this.frame++;
      const dots = ".".repeat((this.frame % 4));
      const text = ` ${sp} ${msg}${dots} `;

      term.clear();

      // 居中绘制 loading 框
      const cy = Math.floor(term.rows / 2);
      const boxW = Math.max(text.length + 4, 30);
      const cx = Math.floor((term.cols - boxW) / 2);

      const topBorder = "╭" + "─".repeat(boxW - 2) + "╮";
      const botBorder = "╰" + "─".repeat(boxW - 2) + "╯";
      const padded = text + " ".repeat(Math.max(0, boxW - 2 - text.length));

      term.moveTo(cy - 1, cx + 1);
      term.write(`\x1b[36m${topBorder}\x1b[0m`);
      term.moveTo(cy, cx + 1);
      term.write(`\x1b[36m│\x1b[1;33m${padded}\x1b[36m│\x1b[0m`);
      term.moveTo(cy + 1, cx + 1);
      term.write(`\x1b[36m${botBorder}\x1b[0m`);

      // 底部提示
      term.moveTo(term.rows, 1);
      term.write("\x1b[2m  Ctrl+C to quit\x1b[0m");
    }, 80);
  }

  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }
}

// ═══════════════════════════════════════════════════════════
//  主 Agent 逻辑
// ═══════════════════════════════════════════════════════════

async function askUser(question: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise<string>((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function main(): Promise<void> {
  // ——— 欢迎界面 ———
  console.clear();
  console.log(`
  \x1b[1;36m╔═════════════════════════════════════════════╗
  ║     🤖  TUI Agent — LLM 全权控制终端         ║
  ╚═════════════════════════════════════════════╝\x1b[0m

  \x1b[33mConfig:\x1b[0m
    API_BASE  = ${process.env.OPENAI_BASE_URL || process.env.BASE_URL || "https://api.openai.com/v1"}
    API_KEY   = ${(process.env.OPENAI_API_KEY || process.env.API_KEY) ? "••••" + (process.env.OPENAI_API_KEY || process.env.API_KEY || "").slice(-4) : "\x1b[31m未设置!\x1b[0m"}
    MODEL     = ${process.env.MODEL || "gpt-4o"}
    Terminal  = ${process.stdout.columns}×${process.stdout.rows}
  `);

  const initialPrompt = await askUser("  \x1b[1;32m▶ 输入你的提示词: \x1b[0m");
  if (!initialPrompt) {
    console.log("  没有输入，退出。");
    process.exit(0);
  }

  // ——— 初始化状态 ———
  const state: AgentState = {
    running: true,
    currentResponse: null,
    loopTimer: null,
    processing: false,
    pendingPrompt: null,
  };

  const history: Array<{ role: string; content: string }> = [];
  const spinner = new LoadingSpinner();
  let abortController: AbortController | null = null;

  // ——— 进入 TUI 模式 ———
  term.setup();
  // 取消 encoding 设置，确保接收 Buffer
  (process.stdin as any).setEncoding(null);

  // ——— 退出清理 ———
  function cleanup(): void {
    if (!state.running) return;
    state.running = false;
    spinner.stop();
    if (state.loopTimer) clearTimeout(state.loopTimer);
    if (abortController) abortController.abort();
    term.teardown();
    console.log("\n  \x1b[1;36m👋 再见！\x1b[0m\n");
    process.exit(0);
  }

  // ——— 核心处理函数 ———
  async function processPrompt(prompt: string): Promise<void> {
    if (!state.running) return;

    if (state.processing) {
      // 队列中只保留最新的一个待处理提示词
      state.pendingPrompt = prompt;
      // 中断正在进行的 LLM 请求
      if (abortController) abortController.abort();
      return;
    }

    state.processing = true;
    state.pendingPrompt = null;

    // 取消自动循环定时器
    if (state.loopTimer) {
      clearTimeout(state.loopTimer);
      state.loopTimer = null;
    }

    spinner.start();
    abortController = new AbortController();

    try {
      const response = await callLLM(prompt, history, abortController.signal);
      spinner.stop();

      if (!state.running) return;

      // 更新对话历史
      history.push({ role: "user", content: prompt });
      // 只保存 screen 的前 500 字符以节省 token
      const historyEntry = {
        ...response,
        screen: response.screen.slice(0, 500) + (response.screen.length > 500 ? "...(truncated)" : ""),
      };
      history.push({
        role: "assistant",
        content: JSON.stringify(historyEntry),
      });
      // 保留最近 20 条消息
      while (history.length > 20) history.splice(0, 2);

      state.currentResponse = response;

      // 渲染画面
      const screenContent = unescapeScreen(response.screen);
      term.fillScreen(screenContent);

      // 设置自动循环
      if (response.loop && response.nextPrompt && state.running) {
        state.loopTimer = setTimeout(() => {
          state.loopTimer = null;
          if (state.running) {
            processPrompt(response.nextPrompt!);
          }
        }, response.minDelay);
      }
    } catch (err: any) {
      spinner.stop();
      if (!state.running) return;

      // 如果是被 abort 的，检查是否有 pending prompt
      if (err.name === "AbortError") {
        // 被新按键中断，不显示错误
      } else {
        // 显示错误画面
        term.clear();
        const errLines = [
          "",
          "  \x1b[1;31m╔══════════════════════════════════════════════╗",
          "  ║                  ⚠  错误  ⚠                 ║",
          "  ╚══════════════════════════════════════════════╝\x1b[0m",
          "",
          `  \x1b[31m${(err.message || String(err)).slice(0, term.cols - 6)}\x1b[0m`,
          "",
          "  \x1b[33m[r] 重试   [q] 退出   [n] 输入新提示词\x1b[0m",
          "",
        ];
        term.fillScreen(errLines.join("\n"));

        state.currentResponse = {
          screen: errLines.join("\n"),
          keyBindings: {
            q: "__quit__",
            escape: "__quit__",
            r: prompt,
            n: "__input__",
          },
          mouseAction: "",
          loop: false,
          nextPrompt: "",
          minDelay: 1000,
        };
      }
    } finally {
      state.processing = false;
      abortController = null;

      // 处理排队的提示词
      if (state.pendingPrompt && state.running) {
        const p = state.pendingPrompt;
        state.pendingPrompt = null;
        processPrompt(p);
      }
    }
  }

  // ——— 输入事件处理 ———
  process.stdin.on("data", (data: Buffer) => {
    if (!state.running) return;

    // Ctrl+C 无条件退出
    if (data.length === 1 && data[0] === 3) {
      cleanup();
      return;
    }

    // 尝试解析鼠标事件
    const mouse = parseMouseEvent(data);
    if (mouse && mouse.type === "press") {
      if (state.currentResponse?.mouseAction) {
        const prompt = state.currentResponse.mouseAction
          .replace(/\{\{x\}\}/g, String(mouse.x))
          .replace(/\{\{y\}\}/g, String(mouse.y))
          .replace(/\{\{col\}\}/g, String(mouse.x))
          .replace(/\{\{row\}\}/g, String(mouse.y))
          .replace(/\{\{button\}\}/g, String(mouse.button));

        if (prompt && prompt !== "__noop__") {
          if (prompt === "__quit__") {
            cleanup();
            return;
          }
          processPrompt(prompt);
        }
      }
      return;
    }

    // 尝试解析按键
    const key = parseKeyName(data);
    if (!key || !state.currentResponse) return;

    const binding = state.currentResponse.keyBindings[key];
    if (!binding || binding === "__noop__") return;

    if (binding === "__quit__") {
      cleanup();
      return;
    }

    // 特殊命令：重新输入提示词（暂不实现 TUI 内输入框，
    // 直接将 "__input__" 视为让用户通过键绑定触发的操作）
    processPrompt(binding);
  });

  // ——— 终端窗口大小变化 ———
  process.stdout.on("resize", () => {
    if (state.currentResponse && state.running && !state.processing) {
      // 窗口大小改变后，用上次的提示词重新生成画面
      const lastUserMsg = history.findLast((m) => m.role === "user");
      if (lastUserMsg) {
        processPrompt(
          `[Terminal resized to ${term.cols}×${term.rows}] ${lastUserMsg.content}`
        );
      } else {
        term.fillScreen(unescapeScreen(state.currentResponse.screen));
      }
    }
  });

  // ——— 信号处理 ———
  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);
  process.on("uncaughtException", (err) => {
    cleanup();
    console.error("Uncaught:", err);
  });

  // ——— 启动！———
  await processPrompt(initialPrompt);
}

// ═══════════════════════════════════════════════════════════
//  入口
// ═══════════════════════════════════════════════════════════

main().catch((err) => {
  try {
    term.teardown();
  } catch {
    /* 忽略 */
  }
  console.error("\n\x1b[1;31m致命错误:\x1b[0m", err.message || err);
  process.exit(1);
});
