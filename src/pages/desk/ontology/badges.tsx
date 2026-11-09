import { statusGlass } from '../deskTheme';

/**
 * Automation: manual grey, one_push blue, auto green, guard black.
 * Basis: "decision" plain, "assumption · <owner>" amber.
 *
 * The desks have no blue token, so one_push uses Tailwind sky with a darker
 * text colour on the light desk theme.
 */
export const AUTOMATION_CLASS: Record<string, string> = {
  manual: statusGlass.idle,
  one_push: 'bg-sky-500/15 border-sky-500/60 text-sky-300 [[data-desk-theme=light]_&]:text-sky-800',
  auto: statusGlass.ok,
  guard: 'bg-black border-white/30 text-white',
};

export const AUTOMATION_LABEL: Record<string, string> = {
  manual: 'manual',
  one_push: 'one push',
  auto: 'auto',
  guard: 'guard',
};

export function automationClass(automation: string | null | undefined): string {
  return AUTOMATION_CLASS[String(automation ?? '')] ?? statusGlass.idle;
}

export function basisClass(basis: string | null | undefined): string {
  return basis === 'assumption' ? statusGlass.warn : statusGlass.idle;
}

export function basisLabel(basis: string | null | undefined, owner: string | null | undefined): string {
  if (basis === 'assumption') return owner ? `assumption · ${owner}` : 'assumption';
  return basis ? String(basis) : 'decision';
}

const PILL = 'desk-pill inline-flex items-center whitespace-nowrap border px-2 py-0.5 text-[11px] font-medium';

export function AutomationBadge({ automation }: { automation: string | null | undefined }) {
  const key = String(automation ?? '');
  return (
    <span className={`${PILL} ${automationClass(key)}`} data-automation={key}>
      {AUTOMATION_LABEL[key] ?? (key || 'manual')}
    </span>
  );
}

export function BasisBadge({ basis, owner }: { basis: string | null | undefined; owner?: string | null }) {
  return (
    <span className={`${PILL} ${basisClass(basis)}`} data-basis={basis ?? 'decision'}>
      {basisLabel(basis, owner)}
    </span>
  );
}

const KIND_CLASS: Record<string, string> = { add: statusGlass.ok, edit: statusGlass.idle, retire: statusGlass.bad };

export function KindBadge({ kind }: { kind: string | null | undefined }) {
  const k = String(kind ?? 'edit');
  return <span className={`${PILL} ${KIND_CLASS[k] ?? statusGlass.idle}`}>{k}</span>;
}
