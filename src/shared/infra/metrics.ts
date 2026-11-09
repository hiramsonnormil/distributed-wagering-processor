/**
 * Métricas em memória por instância, expostas em GET /metrics (formato texto Prometheus).
 * Counters: transações por status, duplicatas, conflitos de idempotência, retries, DLQ,
 * conflitos de lock, divergências de reconciliação.
 * Histogramas: latência de processamento, espera de lock, publicação da outbox.
 * Gauges: outbox lag (idade da mensagem pendente mais antiga), pendentes de referência.
 * Em produção isso seria prom-client/OpenTelemetry; aqui é mínimo e sem dependência.
 */
type Labels = Record<string, string>;
const counters = new Map<string, number>();
const gauges = new Map<string, number>();
const BUCKETS = [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000];
const histograms = new Map<string, { buckets: number[]; sum: number; count: number }>();

const key = (name: string, labels: Labels) => name + JSON.stringify(labels);
const fmt = (k: string) => {
  const i = k.indexOf("{");
  const name = k.slice(0, i);
  const labels = Object.entries(JSON.parse(k.slice(i)) as Labels).map(([a, b]) => `${a}="${b}"`);
  return { name, labels };
};
const line = (name: string, labels: string[], v: number) =>
  `${name}${labels.length ? `{${labels.join(",")}}` : ""} ${v}`;

export const metrics = {
  inc(name: string, labels: Labels = {}, by = 1) {
    const k = key(name, labels);
    counters.set(k, (counters.get(k) ?? 0) + by);
  },
  gauge(name: string, value: number, labels: Labels = {}) {
    gauges.set(key(name, labels), value);
  },
  observe(name: string, ms: number, labels: Labels = {}) {
    const k = key(name, labels);
    const h = histograms.get(k) ?? { buckets: BUCKETS.map(() => 0), sum: 0, count: 0 };
    BUCKETS.forEach((b, i) => {
      if (ms <= b) h.buckets[i]! += 1;
    });
    h.sum += ms;
    h.count += 1;
    histograms.set(k, h);
  },
  value(name: string, labels: Labels = {}): number {
    return counters.get(key(name, labels)) ?? gauges.get(key(name, labels)) ?? 0;
  },
  render(): string {
    const out: string[] = [];
    for (const [k, v] of counters) {
      const { name, labels } = fmt(k);
      out.push(line(name, labels, v));
    }
    for (const [k, v] of gauges) {
      const { name, labels } = fmt(k);
      out.push(line(name, labels, v));
    }
    for (const [k, h] of histograms) {
      const { name, labels } = fmt(k);
      BUCKETS.forEach((b, i) => out.push(line(`${name}_bucket`, [...labels, `le="${b}"`], h.buckets[i]!)));
      out.push(line(`${name}_bucket`, [...labels, `le="+Inf"`], h.count));
      out.push(line(`${name}_sum`, labels, Math.round(h.sum)));
      out.push(line(`${name}_count`, labels, h.count));
    }
    return out.join("\n") + "\n";
  },
};
