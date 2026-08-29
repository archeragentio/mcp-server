const labelValue = (value: string): string => value.replaceAll("\\", "\\\\").replaceAll("\"", "\\\"").replaceAll("\n", "\\n");

export class Metrics {
  readonly #counters = new Map<string, number>();
  readonly #durations = new Map<string, { count: number; sum: number }>();

  increment(name: string, labels: Record<string, string> = {}, amount = 1): void {
    const key = this.#key(name, labels);
    this.#counters.set(key, (this.#counters.get(key) ?? 0) + amount);
  }

  observe(name: string, seconds: number, labels: Record<string, string> = {}): void {
    const key = this.#key(name, labels);
    const current = this.#durations.get(key) ?? { count: 0, sum: 0 };
    current.count += 1;
    current.sum += seconds;
    this.#durations.set(key, current);
  }

  render(): string {
    const lines: string[] = [];
    const counterNames = new Set([...this.#counters.keys()].map(metricName));
    const durationNames = new Set([...this.#durations.keys()].map(metricName));
    for (const name of [...counterNames].sort()) lines.push(`# TYPE ${name} counter`);
    for (const name of [...durationNames].sort()) lines.push(`# TYPE ${name} summary`);
    for (const [key, value] of [...this.#counters].sort(([a], [b]) => a.localeCompare(b))) lines.push(`${key} ${String(value)}`);
    for (const [key, value] of [...this.#durations].sort(([a], [b]) => a.localeCompare(b))) {
      lines.push(`${withSuffix(key, "count")} ${String(value.count)}`, `${withSuffix(key, "sum")} ${String(value.sum)}`);
    }
    return `${lines.join("\n")}\n`;
  }

  #key(name: string, labels: Record<string, string>): string {
    const pairs = Object.entries(labels).sort(([a], [b]) => a.localeCompare(b));
    if (pairs.length === 0) return name;
    return `${name}{${pairs.map(([key, value]) => `${key}="${labelValue(value)}"`).join(",")}}`;
  }
}

function metricName(key: string): string {
  return key.split("{", 1)[0] ?? key;
}

function withSuffix(key: string, suffix: "count" | "sum"): string {
  const labelsAt = key.indexOf("{");
  return labelsAt === -1
    ? `${key}_${suffix}`
    : `${key.slice(0, labelsAt)}_${suffix}${key.slice(labelsAt)}`;
}
