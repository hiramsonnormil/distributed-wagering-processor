/**
 * Contadores em memória expostos em GET /metrics (formato Prometheus).
 * TODO: transações por status, duplicatas, retries, DLQ, conflitos de lock, outbox lag, latência.
 */
const counters = new Map<string, number>();

export const metrics = {
  inc(name: string, labels: Record<string, string> = {}, by = 1) {
    const key = name + JSON.stringify(labels);
    counters.set(key, (counters.get(key) ?? 0) + by);
  },
  render(): string {
    return [...counters.entries()]
      .map(([key, v]) => {
        const i = key.indexOf("{");
        const name = key.slice(0, i);
        const labels = Object.entries(JSON.parse(key.slice(i)) as Record<string, string>)
          .map(([k, val]) => `${k}="${val}"`)
          .join(",");
        return `${name}{${labels}} ${v}`;
      })
      .join("\n");
  },
};
