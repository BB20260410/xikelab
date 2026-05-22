// vitest：observability 模块单测
//   - InMemorySpanExporter 在不开 OTLP 的情况下验 withLLMSpan 字段
//   - 验证 noop（未 init）模式下 withLLMSpan 仍工作（生产 fallback）
//   - 验证 OK / ERROR 状态正确

import { describe, it, expect, beforeAll, afterAll } from 'vitest';

describe('observability/trace', () => {
  let exporter;
  let provider;

  beforeAll(async () => {
    const { NodeTracerProvider } = await import('@opentelemetry/sdk-trace-node');
    const { SimpleSpanProcessor, InMemorySpanExporter } = await import('@opentelemetry/sdk-trace-base');
    exporter = new InMemorySpanExporter();
    provider = new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
    provider.register();
  });

  afterAll(async () => {
    await provider.shutdown();
  });

  it('withLLMSpan 成功路径：写 OK 状态 + 字段全', async () => {
    exporter.reset();
    const { withLLMSpan } = await import('../../src/server/observability/trace.js');
    const out = await withLLMSpan(
      { feature: 'chat', provider: 'claude', model: 'sonnet-4-6', roomId: 'rm-1', adapter_kind: 'spawn' },
      async (h) => {
        h.setUsage({ tokens_in: 800, tokens_out: 1200, cost_usd: 0.0024 });
        return 'ok';
      },
    );
    expect(out).toBe('ok');
    const spans = exporter.getFinishedSpans();
    expect(spans.length).toBe(1);
    const s = spans[0];
    expect(s.name).toBe('claude/sonnet-4-6');
    expect(s.attributes['panel.feature']).toBe('chat');
    expect(s.attributes['panel.provider']).toBe('claude');
    expect(s.attributes['panel.model']).toBe('sonnet-4-6');
    expect(s.attributes['panel.room_id']).toBe('rm-1');
    expect(s.attributes['panel.adapter_kind']).toBe('spawn');
    expect(s.attributes['panel.tokens_in']).toBe(800);
    expect(s.attributes['panel.tokens_out']).toBe(1200);
    expect(s.attributes['panel.cost_usd']).toBe(0.0024);
    expect(s.status.code).toBe(1); // SpanStatusCode.OK
  });

  it('withLLMSpan 失败路径：捕异常 + ERROR 状态 + 重抛', async () => {
    exporter.reset();
    const { withLLMSpan } = await import('../../src/server/observability/trace.js');
    await expect(withLLMSpan(
      { feature: 'debate', provider: 'minimax', model: 'abab-7', adapter_kind: 'chat' },
      async () => { throw new Error('rate_limit'); },
    )).rejects.toThrow('rate_limit');
    const spans = exporter.getFinishedSpans();
    expect(spans.length).toBe(1);
    expect(spans[0].status.code).toBe(2); // SpanStatusCode.ERROR
    expect(spans[0].status.message).toBe('rate_limit');
    expect(spans[0].events.length).toBeGreaterThanOrEqual(1); // recordException
  });

  it('未开 PANEL_OTEL_ENABLED 时 initOtel 返 null + withLLMSpan 仍工作', async () => {
    const { initOtel } = await import('../../src/server/observability/otel.js');
    // 显式不传 endpoint 也不传 enabled，模拟 prod 默认关
    const res = await initOtel({ enabled: false });
    expect(res).toBeNull();
    // withLLMSpan 在 noop tracer 下不应抛
    const { withLLMSpan } = await import('../../src/server/observability/trace.js');
    const out = await withLLMSpan(
      { feature: 'chat', provider: 'claude', model: 'm', adapter_kind: 'spawn' },
      async () => 'fine',
    );
    expect(out).toBe('fine');
  });

  it('setTraceMeta 注入额外业务字段', async () => {
    exporter.reset();
    const { withLLMSpan } = await import('../../src/server/observability/trace.js');
    await withLLMSpan(
      { feature: 'squad', provider: 'codex', model: 'gpt-5', adapter_kind: 'chat' },
      async (h) => { h.setTraceMeta({ retry: 2, fallback_from: 'claude' }); },
    );
    const s = exporter.getFinishedSpans()[0];
    expect(s.attributes['panel.retry']).toBe(2);
    expect(s.attributes['panel.fallback_from']).toBe('claude');
  });
});
