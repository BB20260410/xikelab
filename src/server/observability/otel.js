// panel observability：OpenTelemetry Node SDK + OTLP HTTP exporter
//
// 接 Langfuse self-host 的 OTLP endpoint（path: /api/public/otel/v1/traces）
// 也可以接任意 OTLP 兼容的 collector（Tempo / Jaeger / SigNoz）
//
// 设计依据：
//   - Phase 4 PoC 03（pino-3layer-transport）：吞吐 222k lines/s，BatchSpanProcessor 不阻塞 main
//   - Phase 4 PoC 05（trace_id-cross-spawn）：4/4 adapter spawn 跨进程 trace_id 已通
//   - Phase 7 A1：Helicone 不选（2026-03 Mintlify 收购）→ Langfuse 自托管 + OTel
//
// 启用条件：环境变量 PANEL_OTEL_ENABLED=1，否则导出 noop tracer（零开销）
//
// Langfuse self-host 配置范例：
//   PANEL_OTEL_ENABLED=1
//   PANEL_OTEL_ENDPOINT=http://localhost:3000/api/public/otel/v1/traces
//   PANEL_OTEL_AUTH=Basic <base64(publicKey:secretKey)>
//   PANEL_OTEL_SERVICE_NAME=panel
//
// 不依赖 Langfuse SDK，直接走 OTel 标准协议 → 解耦 + 可换其他 collector

import { trace } from '@opentelemetry/api';

let _provider = null;
let _initPromise = null;

export async function initOtel({
  enabled = process.env.PANEL_OTEL_ENABLED === '1',
  endpoint = process.env.PANEL_OTEL_ENDPOINT,
  auth = process.env.PANEL_OTEL_AUTH,
  serviceName = process.env.PANEL_OTEL_SERVICE_NAME || 'panel',
  serviceVersion = process.env.PANEL_VERSION || 'dev',
} = {}) {
  if (!enabled || !endpoint) return null;
  if (_provider) return _provider;
  if (_initPromise) return _initPromise;

  _initPromise = (async () => {
    const [
      { NodeTracerProvider },
      { BatchSpanProcessor },
      { OTLPTraceExporter },
      pkgResources,
      { SemanticResourceAttributes },
    ] = await Promise.all([
      import('@opentelemetry/sdk-trace-node'),
      import('@opentelemetry/sdk-trace-base'),
      import('@opentelemetry/exporter-trace-otlp-http'),
      import('@opentelemetry/resources'),
      import('@opentelemetry/semantic-conventions'),
    ]);
    const { Resource } = pkgResources.default || pkgResources;

    const exporter = new OTLPTraceExporter({
      url: endpoint,
      headers: auth ? { Authorization: auth } : undefined,
    });

    _provider = new NodeTracerProvider({
      resource: new Resource({
        [SemanticResourceAttributes.SERVICE_NAME]: serviceName,
        [SemanticResourceAttributes.SERVICE_VERSION]: serviceVersion,
      }),
      spanProcessors: [new BatchSpanProcessor(exporter, {
        maxQueueSize: 2048,
        maxExportBatchSize: 64,
        scheduledDelayMillis: 1000,
      })],
    });
    _provider.register();
    return _provider;
  })();
  return _initPromise;
}

export function getTracer(name = 'panel-llm') {
  return trace.getTracer(name);
}

export async function shutdownOtel() {
  if (_provider) {
    await _provider.shutdown();
    _provider = null;
    _initPromise = null;
  }
}
