# dsh-terminal-stream-llm

DeepSeek Harness (DSH) **host 侧插件（无 UI）**：实时捕获终端命令输出，逐块流式上传至 DeepSeek API 进行 LLM 分析。分析增量发布到 cordis 事件总线，并可回显到 host 日志（`logAnalysis`，默认开启）。

> v0.2.0 起移除了 client 半侧（会话面板与 SSE 桥），避免 web 端模块加载面；如需 UI，可从 git 历史（v0.1.x）找回。

## 数据流

```
tools/result 事件（DSH 工具生命周期）
        │  原始输出文本（按命令）
        ▼
行 / 200ms 窗口聚合  ──►  BoundedQueue（容量可配，默认 10）
        │                     │ 队列满：生产端 50ms 重试等待，不丢数据
        ▼                     ▼
DeepSeek Responses API（stream: true）
  ├─ response.output_text.delta      ──►  ctx.emit('terminal-stream/analysis-delta')  ──►  host 日志 [分析] …
  ├─ response.reasoning_text.delta   ──►  ctx.emit('terminal-stream/reasoning-delta') ──►  host 日志 [思考] …
  └─ 状态（TTFT / 字节数 / 错误）     ──►  ctx.emit('terminal-stream/status')          ──►  host 日志 [状态] …
```

## 文件结构

```
src/
  index.ts                 # 插件入口：name / inject / Config / apply
  types.ts                 # 共享 payload 类型 + cordis Events 声明合并
  dsh.d.ts                 # DSH 服务面的结构化类型垫片（见下文"实现说明"）
  host/
    terminal-capture.ts    # 捕获、行/窗口聚合、有界队列、背压、async generator
    deepseek-stream.ts     # DeepSeek 流式调用、重试、中止、StreamListener 发布
  testing.ts               # ./testing 子路径：导出 BoundedQueue 供测试
test/smoke.mjs             # 冒烟测试（真实 cordis 上下文）
package.json  tsconfig.json  tsdown.config.ts  cordis.patch.yml
```

## 安装与测试

### 构建

```bash
cd dsh-terminal-stream-llm
npm install          # 或 pnpm install
npm test             # = tsc --noEmit + tsdown 构建 + 冒烟测试
```

冒烟测试在真实 cordis 根上下文上以 `ctx.plugin()` 挂载插件，验证：

1. `tools/result` 事件 → 捕获 → 聚合 → `terminal-stream/chunk-captured`（含命令头）；
2. 非 watch 名单中的工具被忽略；
3. 容量 2 的队列灌入 6 条数据：队列保持有界、零丢失（背压生效）；
4. `fiber.dispose()` 卸载后副作用全部回卷、进程干净退出（无残留定时器/句柄）；
5. client 产物契约断言（防止 CJS 垫片回归）。

### 安装到本地 profile

```bash
dsh plugin --profile add <profile-name> github:dexp666/dsh-terminal-stream-llm
```

该命令把包安装进 profile 并对账 `dsh.profile.bundles`：本包的 `dsh.bundle.patch`（`cordis.patch.yml`）会把插件插入组合。**重启该 profile 生效**。git 安装拉源码不自动构建：仓库带 `prepare` 脚本，需在 profile 的 `pnpm-workspace.yaml` 加 `allowBuilds: { dsh-terminal-stream-llm: true }` 后重试 add。

### 配置

API Key 不硬编码，经 settings 子系统持久化（cordis.yml 或设置界面）：

```yaml
terminal-stream-llm:
  apiKey: sk-***
  baseURL: https://api.deepseek.com
  model: deepseek-flash
  instructions: 你是一个实时终端日志分析助手。…
  watchTools: [terminal_send, terminal_read, bash, shell]   # 空数组 = 捕获所有工具
  flushWindowMs: 200
  maxQueueSize: 10
  maxOutputBytes: 16384
  maxRetries: 3
  logAnalysis: true    # 分析增量回显到 host 日志
```

### 功能验证

1. 在 DSH 中执行命令（如 `ping -c 10 localhost`），命令完成后 host 日志出现 `[分析] …` 增量；
2. 订阅事件总线的其他插件可消费 `terminal-stream/analysis-delta` / `reasoning-delta` / `status` / `chunk-captured`；
3. 卸载插件后，事件监听、进行中的 API 请求、队列任务全部随 Fiber 自动回卷，无残留错误。

## 实现说明（与常见假设的差异，均为对齐 DSH 真实源码后的事实修正）

对 DeepSeek Harness 仓库（只读分析）核实后发现的部分事实修正：

| 常见假设 | DSH 现状 | 本插件实现 |
|---|---|---|
| `ctx.settings.get('deepseek.apiKey')` | 设置面是 `Config` schema（schemastery）+ settings 注册，无点路径 get | `Config` schema（apiKey 标记 secret），经 cordis.yml / 设置界面持久化 |
| 直接读取 PTY 输出流 | `ctx.terminals`（PTY）为 owner 严格隔离的拉模式，外部插件无法旁路读取 | 捕获端挂接外部插件可用的标准缝：`tools/result`（工具结果冻结快照，含渲染后的终端 viewport/输出文本）；将来若开放 PTY 输出缝，只需替换 `terminal-capture.ts` 的 ingest 源 |
| openai SDK `responses.create` | 仓库内部 LLM 走裸 fetch SSE，`responses.create` 零命中 | 保留 openai SDK `responses.create({ stream: true })` 模式（model/baseURL 可配），并兼容 `response.reasoning_text.delta` 与 `response.reasoning_summary_text.delta` 两种 reasoning 事件 |
| host 事件直达浏览器 | 自定义 host 事件必须进入应用所有的转发白名单，外部插件不可扩展 | 本插件无 client 半侧；事件停留在 host 事件总线（可被其他 host 插件消费）并回显日志 |

其余工程约束均满足：

- **背压**：队列满时捕获端 sleep 50ms 重试，不丢数据（冒烟测试覆盖）；
- **分块**：按行或 200ms 窗口聚合，输出字节上限可配；
- **生命周期**：所有副作用经 `ctx.effect()` 注册，卸载/热重载自动回卷；入口只导出 `name` / `inject` / `Config` / `apply`（前三个是 DSH 插件面约定），管线内部经 `./testing` 子路径导出供测试；
- **重试与中止**：429/5xx 指数退避（最多 3 次，可配），每次流式调用独立 AbortController，插件卸载即中止全部在途请求；
- **错误隔离**：网络异常 / 限流 / 模型错误均记入 `terminal-stream/status`（state: error）并写日志，不中断捕获管线。

## 已知边界

- 捕获以"命令完成"为粒度（`tools/result` 的时机），`ping -c 10` 这类命令的输出在命令结束后进入分析管线；管线内部仍按行/窗口分块流式调 API。真正逐字节的 PTY 旁路流需要 DSH 核心开放新的扩展缝。
- 分析结果当前没有图形界面：通过 host 日志（`logAnalysis`）或订阅事件总线消费。
- 多会话场景下所有捕获输出汇入同一条分析流；`watchTools` 可用于缩小捕获范围。
