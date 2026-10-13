import type { OverdueKind } from '@/lib/vettingOverdueCopy';

export const VET_FOCUS_EVENT = 'welile:vet-focus';
export const SERVICE_CENTER_PATH = '/agent/service-center';

/** Tab value in the Service Centre vetting tabs for each item kind. */
export const KIND_TAB: Record<OverdueKind, string> = { rent_plan: 'rent', landlord: 'landlords', lc1: 'lc1' };

export const vetRowId = (kind: OverdueKind, id: string) => `vet-row-${kind}-${id}`;

export interface VetFocus { kind: OverdueKind; id: string }

/** Go to (or stay on) the Service Centre and focus a queue row. */
export function focusVettingItem(navigate: (to: string) => void, pathname: string, target: VetFocus) {
  if (pathname === SERVICE_CENTER_PATH) {
    window.dispatchEvent(new CustomEvent<VetFocus>(VET_FOCUS_EVENT, { detail: target }));
  } else {
    navigate(`${SERVICE_CENTER_PATH}?vet=${target.kind}&item=${encodeURIComponent(target.id)}`);
  }
}

/** Scroll to a row and highlight it for 2 seconds; retries briefly while the tab renders. */
export function scrollAndHighlight(kind: OverdueKind, id: string) {
  let tries = 0;
  const run = () => {
    const el = document.getElementById(vetRowId(kind, id));
    if (!el) { if (tries++ < 20) setTimeout(run, 150); return; }
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    el.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'center' });
    el.setAttribute('data-vet-highlight', 'true');
    setTimeout(() => el.removeAttribute('data-vet-highlight'), 2000);
  };
  run();
}
