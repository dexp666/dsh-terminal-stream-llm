# dsh-terminal-stream-llm

DeepSeek Harness (DSH) 插件：实时捕获终端命令输出，逐块流式上传至 DeepSeek API 进行 LLM 分析，并将模型的增量分析结果实时渲染在 DSH 会话 UI 的可折叠面板中。

## 数据流

```
tools/result 事件（DSH 工具生命周期）
        │  原始输出文本（按命令）
        ▼
行 / 200ms 窗口聚合  ──►  BoundedQueue（容量可配，默认 10）
        │                     │ 队列满：生产端 50ms 重试等待，不丢数据
        ▼                     ▼
DeepSeek Responses API（stream: true）
  ├─ response.output_text.delta      ──►  ctx.emit('terminal-stream/analysis-delta')
  ├─ response.reasoning_text.delta   ──►  ctx.emit('terminal-stream/reasoning-delta')
  └─ 状态（TTFT / 字节数 / 错误）     ──►  ctx.emit('terminal-stream/status')
        │
        ▼  同一 payload 转发至 SSE 桥（外部插件无法进入核心转发白名单）
/plugins/dsh-terminal-stream/events  (text/event-stream)
        │
        ▼
Client 面板（shell.overlay 插槽，EventSource 自动重连，useSyncExternalStore 渲染）
```

## 文件结构

```
src/
  index.ts                 # 插件入口：name / inject / Config / apply
  types.ts                 # 共享 payload 类型 + cordis Events 声明合并
  dsh.d.ts                 # DSH 服务面的结构化类型垫片（见下文"实现说明"）
  host/
    terminal-capture.ts    # 捕获、行/窗口聚合、有界队列、背压、async generator
    deepseek-stream.ts     # DeepSeek 流式调用、重试、中止、事件发布
    sse-bridge.ts          # SSE 路由（host → browser 的对外流通道）
  client/
    index.tsx              # client 入口：locale、SSE 订阅、shell.overlay 注册
    controller.ts          # 流状态（observable snapshot，供 useSyncExternalStore）
    Panel.tsx              # 可折叠"实时分析"面板（状态/字节/TTFT/思考过程）
    locales.ts             # zh / en 字典
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

1. SSE 路由注册，订阅者收到 `hello` 帧；
2. `tools/result` 事件 → 捕获 → 聚合 → `terminal-stream/chunk-captured`（含命令头）；
3. 非 watch 名单中的工具被忽略；
4. 容量 2 的队列灌入 6 条数据：队列保持有界、零丢失（背压生效）；
5. `fiber.dispose()` 卸载后 SSE 路由已注销、进程干净退出（无残留定时器/句柄）。

### 安装到本地 profile

```bash
dsh plugin --profile add <profile-name> /path/to/dsh-terminal-stream-llm
```

该命令把包安装进 profile 并对账 `dsh.profile.bundles`：本包的 `dsh.bundle.patch`（`cordis.patch.yml`）会把插件插入组合。**重启该 profile 生效**（bundle 层变更不走热重载）。

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
```

### 功能验证

1. 在 DSH 中执行持续输出命令（如 `ping -c 10 localhost`），命令完成后右下角出现"实时分析"面板，模型增量结果实时渲染；
2. 面板标题栏显示连接状态、已接收输出字节、首 Token 延迟（TTFT）；"思考过程"可展开查看 reasoning 增量；
3. 卸载插件（`dsh plugin --profile remove …` 或停用 entry）后，事件监听、SSE 路由、进行中的 API 请求、EventSource 全部随 Fiber 自动回卷，控制台无残留错误。

## 实现说明（与任务书的差异，均为对齐 DSH 真实源码后的事实修正）

对 DeepSeek Harness 仓库（只读分析）核实后发现任务书引用的部分 API 在当前 DSH 中不存在，本插件按真实 API 实现：

| 任务书假设 | DSH 现状 | 本插件实现 |
|---|---|---|
| `ctx.settings.get('deepseek.apiKey')` | 设置面是 `Config` schema（schemastery）+ settings 注册，无点路径 get | `Config` schema（apiKey 标记 secret），经 cordis.yml / 设置界面持久化 |
| `dsh-tool-ssh` / `dsh-plugin-live-terminal` 参考插件 | 仓库中不存在这两个包；PTY 服务（`ctx.terminals`）为 owner 严格隔离的拉模式，外部插件无法旁路读取 | 捕获端挂接外部插件可用的标准缝：`tools/result`（工具结果冻结快照，含渲染后的终端 viewport/输出文本），聚合管线与任务书要求完全一致；将来若开放 PTY 输出缝，只需替换 `terminal-capture.ts` 的 ingest 源 |
| `openai` SDK `responses.create` | 仓库内部 LLM 走裸 fetch SSE（chat-completions/anthropic），`responses.create` 零命中 | 按任务书保留 openai SDK `responses.create({ stream: true })` 模式（model/baseURL 可配），并兼容处理 `response.reasoning_text.delta` 与 `response.reasoning_summary_text.delta` 两种 reasoning 事件 |
| host→client 用 `ctx.emit` 直达 | 自定义 host 事件必须进入 `packages/api/remotes` 的转发白名单，该白名单应用所有、外部插件不可扩展；网关只允许唯一事件源 | host 侧照常 `ctx.emit`（类型化总线，供其他 host 插件消费）；到达浏览器走本插件自有的 webserver SSE 路由（webserver 包明文允许 handler 长持响应，gzip 自动跳过 event-stream） |
| client 插件参考 `ui-message-feedback` | 一致 | 完全按其结构：空 host 半 + `exports["./client"]` + `dsh.client` 声明 + slots 注册 + locale 字典 |
| 样式用 DSH CSS 变量 | 面板类浮层用 `--dsw-alias-*` 语义 token；仓库内 CSS Modules 依赖其私有 tsdown preset | 面板样式运行时注入单个 `<style>`，全部使用 `--dsw-alias-*`（含降级回退），不依赖私有构建 preset |

其余任务书约束均满足：

- **背压**：队列满时捕获端 sleep 50ms 重试，不丢数据（冒烟测试第 4 项覆盖）；
- **分块**：按行或 200ms 窗口聚合，输出字节上限可配；
- **生命周期**：所有副作用经 `ctx.effect()` 注册，卸载/热重载自动回卷；入口只导出 `name` / `inject` / `Config` / `apply`（前三个是 DSH 插件面约定），管线内部经 `./testing` 子路径导出供测试；
- **重试与中止**：429/5xx 指数退避（最多 3 次，可配），每次流式调用独立 AbortController，插件卸载即中止全部在途请求；
- **错误隔离**：网络异常 / 限流 / 模型错误均记入 `terminal-stream/status`（state: error）并写日志，不中断捕获管线。

## 已知边界

- 捕获以"命令完成"为粒度（`tools/result` 的时机），`ping -c 10` 这类命令的输出在命令结束后进入分析管线；管线内部仍按行/窗口分块流式调 API。真正逐字节的 PTY 旁路流需要 DSH 核心开放新的扩展缝。
- 无 webServer 服务的运行形态（如纯 IPC 的 Electron 配置）下，host 侧正常工作，client 面板显示"未连接"。
- 多会话场景下所有捕获输出汇入同一条分析流；`watchTools` 可用于缩小捕获范围。
