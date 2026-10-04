/** Shared, deterministic visual helpers for the Service Center roster. */
export function initialsOf(name?: string | null) {
  if (!name) return 'SA';
  return name.trim().split(/\s+/).slice(0, 2).map((p) => p[0]?.toUpperCase() ?? '').join('') || 'SA';
}

const TINTS = [
  { header: 'bg-primary/10', fallback: 'bg-primary/20 text-primary', rail: 'bg-primary' },
  { header: 'bg-success/10', fallback: 'bg-success/20 text-success', rail: 'bg-success' },
  { header: 'bg-warning/10', fallback: 'bg-warning/20 text-warning', rail: 'bg-warning' },
  { header: 'bg-accent', fallback: 'bg-accent text-accent-foreground', rail: 'bg-muted-foreground' },
] as const;

export type SubAgentTint = (typeof TINTS)[number];

/** Stable colour per sub-agent so cards stay recognisable between loads. */
export function tintFor(id: string): SubAgentTint {
  let hash = 0;
  for (let i = 0; i < id.length; i += 1) hash = (hash * 31 + id.charCodeAt(i)) % 997;
  return TINTS[hash % TINTS.length];
}
