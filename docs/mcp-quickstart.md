# MCP 30 秒接入

MCP（Model Context Protocol）= Anthropic 标准的"工具协议"。让 Claude / 兼容 AI 调用外部 tool（filesystem / github / 浏览器 / 数据库 / 自定义）。

panel 一站式接入。

## 30 秒接 filesystem（最常用）

1. 顶栏点 🔌 MCP
2. 点 **＋ 新建**
3. 填：
   - name: `fs-desktop`
   - type: `stdio`
   - command: `npx`
   - args: `-y @modelcontextprotocol/server-filesystem ~/Desktop`
4. 点 **💾 保存** → **🧪 测试连接**
5. 看到 `✓ 连接成功 · 11 tools` 即可

下次 Claude spawn 会自动挂这个 MCP（CLI 原生 `--mcp-config`）。

Claude 房间里你能让它：「读 ~/Desktop/notes.md 第 3 段」「在 ~/Desktop 新建 todo.md 写 X」。

## 常用 MCP server（社区）

| server | command | 能干嘛 |
|---|---|---|
| filesystem | `npx -y @modelcontextprotocol/server-filesystem <path>` | 读写指定目录文件 |
| github | `npx -y @modelcontextprotocol/server-github` | 操作 GitHub Issue/PR/Code（需 GITHUB_TOKEN env）|
| puppeteer | `npx -y @modelcontextprotocol/server-puppeteer` | 让 AI 跑浏览器 / 截图 / 爬数据 |
| postgres | `npx -y @modelcontextprotocol/server-postgres <url>` | 查 PG 数据库 |
| brave-search | `npx -y @modelcontextprotocol/server-brave-search` | 联网搜索 |
| memory | `npx -y @modelcontextprotocol/server-memory` | 长期记忆 store |

完整列表：[modelcontextprotocol/servers](https://github.com/modelcontextprotocol/servers)

## panel MCP 高级功能

### 📂 查看 Resources（W7 + B-013）

server 暴露的 "resource"（不只 tool）。点 MCP detail → **📂 查看 Resources**。

### 💬 查看 Prompts

server 提供的预定义 prompt 模板。点 MCP detail → **💬 查看 Prompts**。

### 📜 调用历史（W7 接入）

MCP modal 头部 → **📜 调用历史**。看最近 50 次 tool 调用：
- 时间 / server / tool / 耗时 / 成功失败 / error 详情
- 日志落 `~/.claude-panel/mcp-calls-YYYY-MM.jsonl`（0o600）

## 自定义 MCP server

写一个自己的 server 接 panel：

```js
// my-mcp-server.js
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

const s = new Server({ name: 'my-tools', version: '1.0' }, {
  capabilities: { tools: {} },
});
s.setRequestHandler('tools/list', () => ({
  tools: [{ name: 'greet', description: '问候', inputSchema: { type: 'object', properties: { name: { type: 'string' } } } }],
}));
s.setRequestHandler('tools/call', async (req) => {
  if (req.params.name === 'greet') return { content: [{ type: 'text', text: `Hi ${req.params.arguments.name}!` }] };
});
await s.connect(new StdioServerTransport());
```

panel 配 `node /path/to/my-mcp-server.js` 即可挂载。

## 安全

panel MCP 沙箱：
- command 禁含空格 / 元字符（$ ; & |）/ 危险词（rm/curl/sudo/wget）
- args 长度 cap 2048
- env 仅允许 `[A-Z_]` 键
- 调用超时强制 disconnect 子进程（v0.73 修复）
- jsonl 历史日志权限 0o600

下一步：[autopilot-guide.md](./autopilot-guide.md)
