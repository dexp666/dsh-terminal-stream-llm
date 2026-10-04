/**
 * Locale dictionaries for dsh-terminal-stream-llm (client half).
 * `zh` is the key source; `en` must satisfy the same key set.
 */

export const NS = 'terminal-stream-llm'

export const zh = {
  'panel.title': '实时分析',
  'panel.collapse': '收起面板',
  'panel.expand': '展开面板',
  'panel.clear': '清空',
  'panel.reasoning': '思考过程',
  'status.connecting': '连接中',
  'status.live': '已连接',
  'status.disconnected': '未连接',
  'state.idle': '空闲',
  'state.capturing': '捕获中',
  'state.streaming': '分析中',
  'state.error': '错误',
  'ttft.label': '首 Token',
  'bytes.label': '输出字节',
  'empty.hint': '在 DSH 中执行命令后，分析结果会实时出现在这里。',
} satisfies Record<string, string>

export type TerminalStreamKey = keyof typeof zh

export const en = {
  'panel.title': 'Live Analysis',
  'panel.collapse': 'Collapse panel',
  'panel.expand': 'Expand panel',
  'panel.clear': 'Clear',
  'panel.reasoning': 'Reasoning',
  'status.connecting': 'Connecting',
  'status.live': 'Connected',
  'status.disconnected': 'Disconnected',
  'state.idle': 'Idle',
  'state.capturing': 'Capturing',
  'state.streaming': 'Analyzing',
  'state.error': 'Error',
  'ttft.label': 'TTFT',
  'bytes.label': 'Output bytes',
  'empty.hint': 'Run a command in DSH and the analysis will stream in here.',
} satisfies Record<TerminalStreamKey, string>

