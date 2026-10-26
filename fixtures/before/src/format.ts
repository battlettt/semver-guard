function pad(value: number): string {
  return String(value).padStart(2, '0');
}

export function formatDate(date: Date, locale: string): string {
  return date.toLocaleDateString(locale);
}

export function formatTime(date: Date): string {
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function greet(name: string): string {
  return `Hello, ${name}`;
}
