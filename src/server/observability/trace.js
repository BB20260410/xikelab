// panel observability：LLM 调用 span 包装器
//
// 给 14 adapter 提供统一接入面，按 Phase 2 § 3.2 设计的字段 schema 上报：
//   feature / provider / model / room_id / adapter_kind / tokens_in / tokens_out / cost_usd / status
//
// 用法（adapter 内）：
//   import { withLLMSpan } from '../observability/trace.js';
//   const result = await withLLMSpan(
//     { feature: 'chat', provider: 'claude', model: 'sonnet-4-6', roomId, adapter_kind: 'spawn' },
//     async (span) => {
//       // ... 调 LLM
//       span.setUsage({ tokens_in: 800, tokens_out: 1200, cost_usd: 0.0024 });
//       return result;
//     }
//   );
//
// 设计原则：
//   - PANEL_OTEL_ENABLED 未开时 withLLMSpan 仍正常工作（noop tracer），零侵入
//   - span.setUsage / span.setTraceMeta 在 noop tracer 下也是空操作
//   - 异常自动捕到 span.recordException + ERROR status

import { SpanStatusCode } from '@opentelemetry/api';
import { getTracer } from './otel.js';

export async function withLLMSpan({ feature, provider, model, roomId, adapter_kind, parentSpan }, work) {
  const tracer = getTracer('panel-llm');
  const span = tracer.startSpan(`${provider}/${model}`, {
    attributes: {
      'panel.feature': feature,
      'panel.provider': provider,
      'panel.model': model,
      'panel.adapter_kind': adapter_kind,
      ...(roomId ? { 'panel.room_id': roomId } : {}),
    },
  }, parentSpan);

  const handle = {
    span,
    setUsage({ tokens_in, tokens_out, cost_usd, ttft_ms } = {}) {
      if (tokens_in !== undefined) span.setAttribute('panel.tokens_in', tokens_in);
      if (tokens_out !== undefined) span.setAttribute('panel.tokens_out', tokens_out);
      if (cost_usd !== undefined) span.setAttribute('panel.cost_usd', cost_usd);
      if (ttft_ms !== undefined) span.setAttribute('panel.ttft_ms', ttft_ms);
    },
    setTraceMeta(meta = {}) {
      for (const [k, v] of Object.entries(meta)) {
        if (v !== undefined && v !== null) span.setAttribute(`panel.${k}`, v);
      }
    },
  };

  try {
    const out = await work(handle);
    span.setStatus({ code: SpanStatusCode.OK });
    return out;
  } catch (e) {
    span.recordException(e);
    span.setStatus({ code: SpanStatusCode.ERROR, message: e.message || String(e) });
    throw e;
  } finally {
    span.end();
  }
}
