const UNITS: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 };

export function parseDuration(text: string): number {
  const match = /^(\d+)(ms|s|m|h)$/.exec(text.trim());
  if (!match) throw new Error(`invalid duration: ${text}`);
  return Number(match[1]) * UNITS[match[2]];
}
