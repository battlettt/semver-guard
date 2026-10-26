// Internal helper changed: not exported, so not part of the API.
function pad(value: number, width = 2): string {
  return String(value).padStart(width, '0');
}

export interface FormatOptions {
  locale: string;
  utc?: boolean;
}

export function formatDate(date: Date, options: FormatOptions): string {
  return date.toLocaleDateString(options.locale, options.utc ? { timeZone: 'UTC' } : {});
}

export function formatTime(date: Date): string {
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

// Adding an optional parameter is backwards compatible.
export function greet(name: string, punctuation?: string): string {
  return `Hello, ${name}${punctuation ?? ''}`;
}
