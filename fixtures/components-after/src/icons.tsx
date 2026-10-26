// Internal module: imported by Button, not exported from the entry point.
export function iconFor(icon: { name: string; size: number }) {
  return <i className={`icon-${icon.name}`} style={{ fontSize: icon.size }} />;
}
