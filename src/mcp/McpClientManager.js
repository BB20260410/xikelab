// v0.55 Sprint 12 — MCP Client Manager
//
// 管理多个 MCP server 的连接（stdio / sse / http），提供 listTools / callTool 等高层 API
// 设计：lazy 连接（首次调用时才 connect）+ 连接复用 + 进程退出时 disconnect 全部

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const CONNECT_TIMEOUT_MS = 30_000;
const CALL_TOOL_TIMEOUT_MS = 60_000;

export class McpClientManager {
  constructor({ store } = {}) {
    if (!store) throw new Error('McpClientManager: store required');
    this.store = store;
    // Map<name, { client, transport, connectedAt, lastError }>
    this.conns = new Map();
  }

  /** 拿配置 + lazy 连接；已连返回现有 client */
  async ensureConnected(name) {
    const exist = this.conns.get(name);
    if (exist && exist.client) return exist;

    const cfg = this.store.get(name);
    if (!cfg) throw new Error(`MCP server "${name}" 不存在`);
    if (cfg.enabled === false) throw new Error(`MCP server "${name}" 已禁用`);

    let transport;
    if (cfg.type === 'stdio') {
      // 合并 process.env（保 PATH 等）+ 用户 env
      const env = { ...process.env, ...(cfg.env || {}) };
      transport = new StdioClientTransport({
        command: cfg.command,
        args: cfg.args || [],
        env,
      });
    } else if (cfg.type === 'sse') {
      const url = new URL(cfg.url);
      transport = new SSEClientTransport(url, {
        requestInit: cfg.headers && Object.keys(cfg.headers).length > 0
          ? { headers: cfg.headers }
          : undefined,
      });
    } else if (cfg.type === 'http') {
      const url = new URL(cfg.url);
      transport = new StreamableHTTPClientTransport(url, {
        requestInit: cfg.headers && Object.keys(cfg.headers).length > 0
          ? { headers: cfg.headers }
          : undefined,
      });
    } else {
      throw new Error(`unknown type: ${cfg.type}`);
    }

    const client = new Client(
      { name: 'claude-panel', version: '0.55.0' },
      { capabilities: { tools: {}, resources: {}, prompts: {} } }
    );

    // 连接（带超时）
    const connectP = client.connect(transport);
    const timeoutP = new Promise((_, rej) => setTimeout(() => rej(new Error('connect timeout')), CONNECT_TIMEOUT_MS));
    try {
      await Promise.race([connectP, timeoutP]);
    } catch (e) {
      try { await transport.close(); } catch {}
      const entry = { client: null, transport: null, connectedAt: null, lastError: e.message };
      this.conns.set(name, entry);
      throw new Error(`MCP "${name}" 连接失败: ${e.message}`);
    }

    const entry = { client, transport, connectedAt: new Date().toISOString(), lastError: null };
    this.conns.set(name, entry);

    // 监听 transport 断开
    transport.onclose = () => {
      const e = this.conns.get(name);
      if (e) { e.client = null; e.transport = null; }
    };
    transport.onerror = (err) => {
      const e = this.conns.get(name);
      if (e) e.lastError = String(err?.message || err);
    };

    return entry;
  }

  /** 列出某 server 的 tools；若已 cache（同一 server 当前 connection 期内）直接返 */
  async listTools(name) {
    const entry = await this.ensureConnected(name);
    if (entry._toolsCache) return entry._toolsCache;
    const res = await entry.client.listTools();
    entry._toolsCache = res.tools || [];
    return entry._toolsCache;
  }

  /** 列 resources */
  async listResources(name) {
    const entry = await this.ensureConnected(name);
    try {
      const res = await entry.client.listResources();
      return res.resources || [];
    } catch (e) {
      // server 可能不支持 resources，安全返空
      return [];
    }
  }

  /** 列 prompts */
  async listPrompts(name) {
    const entry = await this.ensureConnected(name);
    try {
      const res = await entry.client.listPrompts();
      return res.prompts || [];
    } catch (e) {
      return [];
    }
  }

  /** 调一个 tool（带超时） */
  async callTool(name, toolName, args = {}) {
    const entry = await this.ensureConnected(name);
    const callP = entry.client.callTool({ name: toolName, arguments: args });
    const timeoutP = new Promise((_, rej) => setTimeout(() => rej(new Error('callTool timeout')), CALL_TOOL_TIMEOUT_MS));
    return Promise.race([callP, timeoutP]);
  }

  /** 关一个 server */
  async disconnect(name) {
    const entry = this.conns.get(name);
    if (!entry) return false;
    try { if (entry.client) await entry.client.close(); } catch {}
    try { if (entry.transport) await entry.transport.close(); } catch {}
    this.conns.delete(name);
    return true;
  }

  /** 关全部（gracefulShutdown 用） */
  async disconnectAll() {
    const names = Array.from(this.conns.keys());
    await Promise.all(names.map((n) => this.disconnect(n).catch(() => {})));
  }

  /** 状态摘要（给 health / list 用） */
  status() {
    const out = {};
    for (const [name, entry] of this.conns) {
      out[name] = {
        connected: !!entry.client,
        connectedAt: entry.connectedAt,
        lastError: entry.lastError,
        toolsCount: entry._toolsCache?.length || null,
      };
    }
    return out;
  }
}
