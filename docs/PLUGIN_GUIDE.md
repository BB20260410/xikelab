# Plugin 开发指南

> Claude Panel v0.52 W2 起，任意 CLI 工具都能通过一份 JSON manifest 接入。
> 安装位置：`~/.claude-panel/cli-plugins/<id>.json`（0o600，原子写）

---

## 1. 5 分钟上手

### 装 plugin

```bash
# 法 1：把 manifest 文件丢到目录
cp my-tool.json ~/.claude-panel/cli-plugins/my-tool.json
# 重启 panel 或在 🧩 Plugin 中心点"⟳ 刷新"

# 法 2：通过 UI 上传
# 点顶栏 🧩 → ＋ 安装 Plugin → 选 my-tool.json
```

### 跑一个命令

进 🧩 Plugin 中心 → 左侧点 plugin → 右侧"命令清单"点 `▶ 跑` → 弹 modal 填 prompt + 参数 → 执行 → 看输出 + dashboard。

---

## 2. Manifest schema 全字段

每份 manifest 包含 8 大段：

```jsonc
{
  // ───── 1. 基础元信息 ─────
  "id": "praisonai",                  // 必填，小写 [a-z0-9_-] 1-40 字符，唯一
  "displayName": "🤖 PraisonAI",       // 必填，UI 显示
  "version": "1.0.0",                  // 可选，semver
  "icon": "🤖",                        // 可选，emoji 单字符
  "type": "spawn",                     // 必填，"spawn" | "http"（W1 仅 spawn）

  // ───── 2. 可执行文件 ─────
  "bin": {
    "cmd": "praisonai",                // 必填，binary 名或绝对路径
    "check": "which praisonai",        // 可选，启动期探测命令
    "fallback": "~/.local/bin/xxx",    // 可选，which 没命中时的兜底绝对路径
    "env": "PRAISONAI_BIN"             // 可选，env var override（优先级最高）
  },

  // ───── 3. 输入协议 ─────
  "input": {
    "mode": "stdin",                   // "stdin" | "argv" | "file"
    "encoding": "utf-8",
    "filePathArg": "-f"                // mode=file 时必填，告诉 CLI 用哪个 flag 接文件路径
  },

  // ───── 4. 输出协议 ─────
  "output": {
    "mode": "stream",                  // "stream" | "file"
    "parser": "raw",                   // "raw" | "jsonl" | "openai-stream" | "claude-stream"
    "filePathArg": "-o",               // mode=file 时填，告诉 CLI 用哪个 flag 接输出路径
    "tokensRegex": "tokens:\\s*(\\d+)",// 可选，从 stdout 抓 tokens 数
    "replyJsonPath": ".choices[0].message.content"  // jsonl/json 时抽 reply 路径
  },

  // ───── 5. 命令清单 ─────
  "commands": [
    {
      "id": "agents-run",              // 必填，命令 id
      "name": "Run Agents",             // 必填，UI 显示名
      "description": "...",            // 可选
      "args": ["agents", "{topic}"],   // 必填，argv 模板。{paramName} 会被替换
      "params": [
        {
          "name": "topic",
          "type": "string",            // "string" | "number" | "boolean" | "enum"
          "required": true,
          "maxLen": 8000,
          "default": "...",
          "enumValues": ["a","b","c"]  // type=enum 时必填
        }
      ]
    }
  ],

  // ───── 6. 事件源（仪表盘用）─────
  "events": {
    "source": "stdout-jsonl",          // "stdout" | "stdout-jsonl" | "log-tail" | "sse:url" | "ws:url"
    "path": "/var/log/xxx.log",        // source=log-tail 时填
    "schema": "openai"                 // "raw" | "openai" | "claude-stream" | "custom"
  },

  // ───── 7. 仪表盘卡片 ─────
  "dashboard": [
    {
      "type": "status-bar",            // "status-bar" | "list" | "log" | "metric"
      "title": "运行统计",
      "fields": ["agentCount", "tokensUsed", "count"]
    },
    {
      "type": "list",
      "title": "活跃 agent",
      "source": "events.agent_started", // 启动事件名
      "until": "events.agent_finished"  // 结束事件名（按 id 匹配项移除）
    },
    {
      "type": "log",
      "title": "输出",
      "source": "stdout",
      "maxLines": 500
    },
    {
      "type": "metric",
      "title": "指标",
      "fields": ["tokensUsed"]
    }
  ],

  // ───── 8. 沙箱 ─────
  "sandbox": {
    "cwdScope": "home-tree",           // "home-tree" | "tmp-only" | "explicit-list"
    "explicitCwdList": ["/path/a"],    // cwdScope=explicit-list 时填
    "envWhitelist": ["LANG", "PATH"],  // 透传给 spawn 的环境变量
    "timeoutMs": 1800000               // 单次调用超时，1000-7200000ms
  },

  // ───── 9. 自定义元数据 ─────
  "extra": {                            // 自由字段，panel 不解析
    "install": "pip install xxx",
    "docs": "https://..."
  }
}
```

---

## 3. 写一份新 manifest（10 分钟）

假设你想接入 `ollama` 让它在 panel 里跑：

### Step 1：搞清 CLI 用法
```bash
$ ollama --help
ollama run <model> <prompt>
```

### Step 2：写 manifest
```json
{
  "id": "ollama-cli",
  "displayName": "🔵 Ollama CLI",
  "version": "0.1.0",
  "icon": "🔵",
  "type": "spawn",
  "bin": { "cmd": "ollama", "check": "which ollama" },
  "input": { "mode": "argv" },
  "output": { "mode": "stream", "parser": "raw" },
  "commands": [
    {
      "id": "run",
      "name": "Run Model",
      "args": ["run", "{model}", "{prompt}"],
      "params": [
        { "name": "model", "type": "string", "required": true, "default": "qwen2.5:7b" },
        { "name": "prompt", "type": "string", "required": true, "maxLen": 8000 }
      ]
    }
  ],
  "sandbox": { "cwdScope": "home-tree", "timeoutMs": 600000 }
}
```

### Step 3：装 + 跑
```bash
cp ollama-cli.json ~/.claude-panel/cli-plugins/
# 浏览器进 🧩 → 找到 "🔵 Ollama CLI" → 点 ▶ 跑 → 填 prompt
```

---

## 4. 5 份完整示例

| 文件 | 类型 | 说明 |
|---|---|---|
| `src/plugin/builtin/claude.json` | spawn | Claude CLI 内置，无 dashboard |
| `src/plugin/builtin/codex.json` | spawn | Codex CLI 内置，output mode=file |
| `src/plugin/builtin/gemini-cli.json` | spawn | Gemini CLI 内置 |
| `src/plugin/examples/praisonai.json` | spawn | PraisonAI multi-agent + dashboard |
| `src/plugin/examples/ios-toolchain.json` | spawn | xcodebuild 4 个命令（build/test/clean/archive）|
| `src/plugin/examples/autogen.json` | spawn | AutoGen 通过 `python3 -c` 跑 |

---

## 5. 调试技巧

### 装上去 plugin 显示"不可用"
- 看 plugin 详情页错误 banner，多半是 `bin "xxx" 找不到（which 未命中、fallback 不存在）`
- 解决：要么 `export PRAISONAI_BIN=/abs/path` 然后重启 panel，要么 manifest.bin.fallback 填绝对路径

### exec 命令报 `参数 X 必填`
- params 表 `required: true` 但 modal 留空
- 解决：填上

### exec 返 `kind 格式不识别` / `manifest schema 校验失败`
- ajv 报错信息会指出具体字段
- 解决：对照 schema 文件 `docs/plugin-manifest.schema.json`

### dashboard 显示 `跑命令后填充`
- 没跑过命令 → 正常
- 跑了还没填充 → 检查 manifest.events.source；如果是 `stdout-jsonl` 但 CLI 输出不是每行 JSON，会被忽略

### 想看 schema 校验报错细节
```bash
node --input-type=module -e "
import Ajv from 'ajv';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const ajv = new Ajv({ allErrors: true, meta: false, schemaId: 'auto' });
ajv.addMetaSchema(require('ajv/lib/refs/json-schema-draft-07.json'));
const schema = JSON.parse(readFileSync('docs/plugin-manifest.schema.json', 'utf-8'));
delete schema.\$schema;
const validate = ajv.compile(schema);
const m = JSON.parse(readFileSync('path/to/my-manifest.json', 'utf-8'));
console.log(validate(m) ? '✅' : validate.errors);
"
```

---

## 6. API 端点速查

| 方法 | 端点 | 说明 |
|---|---|---|
| GET  | `/api/plugins` | 列已加载 plugin 摘要 |
| GET  | `/api/plugins/:id` | 拿完整 manifest |
| POST | `/api/plugins/install` | 装 manifest（body 直接是 manifest 对象，≤32KB）|
| DELETE | `/api/plugins/:id` | 卸载（内置不可卸）|
| POST | `/api/plugins/reload` | 重扫两个目录 |
| POST | `/api/plugins/:id/exec` | 跑 command：`{ commandId, params, prompt, model, cwd }` |

---

## 7. 安全边界

- **cwd 沙箱**：所有 spawn 的工作目录必须在 home 子树或 `/tmp` 下（与 panel 通用沙箱一致）
- **envWhitelist**：默认只透传 `LANG / LC_ALL / PATH`，不漏其他 env var
- **bin 绝对路径校验**：相对路径 `which` 解析后必须是 absolute；fallback 必须 absolute
- **manifest 32KB 上限**：防 DoS
- **内置 plugin id 不可被用户 manifest 覆盖**：避免 hack `claude` 这种关键 id
- **超时硬上限 2 小时**：防 spawn 卡死

---

## 8. W3 路线（未来）

- log-tail / SSE / WebSocket 实时事件源
- HTTP type plugin（接 REST API）
- Plugin marketplace（GitHub 集中 manifest 库 + 一键装）
- Plugin manifest 签名验证
- 仪表盘自定义渲染器（用户可塞 JS 渲染函数）
