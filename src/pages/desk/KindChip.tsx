import { pillLayout } from './ui/layout';

/**
 * What kind of request a row is (E73), from the server's `row.kind`
 * (`_request_kind_json`): New, Renewal, or Self-applied, each in its own
 * colour. The colour is a dot and a border, the words stay in the text colour
 * so they read on both themes.
 *
 *   New           #475569  "New"            (detail in the tooltip)
 *   Renewal       #0EA5E9  "Renewal · Plan 2 · repaid 100% before"
 *   Self-applied  #DB2777  "Self-applied · via tenant app"
 */

export type RequestKind = {
  code: 'new' | 'renewal' | 'self_applied' | string;
  label: string | null;
  color: string | null;
  detail: string | null;
  /** Self-applied: "tenant app" or "WhatsApp assistant". */
  via?: string | null;
  /** Self-applied with no real agent yet: Agent Ops assigns one. */
  needs_agent?: boolean | null;
};

export const KIND_COLOR: Record<string, string> = { new: '#475569', renewal: '#0EA5E9', self_applied: '#DB2777' };
const KIND_LABEL: Record<string, string> = { new: 'New', renewal: 'Renewal', self_applied: 'Self-applied' };

/** The chip's words: Renewal shows its detail, Self-applied how it came in, New only its name. */
export function kindText(k: RequestKind): string {
  const label = k.label || KIND_LABEL[k.code] || k.code;
  if (k.code === 'renewal' && k.detail) return `${label} · ${k.detail}`;
  if (k.code === 'self_applied' && k.via) return `${label} · via ${k.via}`;
  return label;
}

export function kindColor(k: RequestKind): string {
  const c = k.color ?? '';
  return /^#[0-9a-f]{3,8}$/i.test(c) ? c : KIND_COLOR[k.code] ?? '#475569';
}

export function KindChip({ kind }: { kind: RequestKind | null | undefined }) {
  if (!kind || !kind.code) return null;
  const color = kindColor(kind);
  return (
    <span
      data-kind={kind.code}
      title={kind.detail ?? undefined}
      className="desk-pill text-[11px] text-foreground"
      style={{ ...pillLayout(8, 2, 5), border: `1px solid ${color}`, background: `${color}14` }}
    >
      <span aria-hidden style={{ width: 7, height: 7, borderRadius: 999, background: color, flex: '0 0 auto' }} />
      {kindText(kind)}
    </span>
  );
}
