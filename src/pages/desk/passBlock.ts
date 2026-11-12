import type { CheckEntry, ChecklistItem } from './reviewTypes';

/**
 * Why Pass cannot go yet, in the few words the desk shows right under it:
 * "Answer 5 more checks", "Enter the rent the landlord states", "Choose a
 * reason code". Null when nothing stands in the way.
 *
 * The order is the order the reviewer works in: the call, the checks, the
 * figures the checks ask for, then the reason and note for going against the
 * system. Only the first thing left is said.
 */

export const PASS_NOTE_MIN = 10;

/** What a check that takes a figure or a written answer asks for, once it is ticked Pass. */
const VALUE_ASK: Record<string, string> = {
  lo_rent_confirmed: 'Enter the rent the landlord states',
  to_rent_confirmed: 'Enter the rent the tenant states',
  sc_family_size: 'Enter the family size',
  sc_lc1_letter: 'Write who confirmed the LC1 letter by phone',
};

/** True for a check whose Pass needs a figure (or, for the LC1 letter with no file, a written answer). */
export function needsValue(item: Pick<ChecklistItem, 'code' | 'value_kind'>, lc1NeedsText = false): boolean {
  if (item.code === 'lo_rent_confirmed') return true;
  if (item.code === 'sc_lc1_letter') return lc1NeedsText;
  return item.value_kind === 'amount' || item.value_kind === 'number';
}

const empty = (v: unknown) => v === undefined || v === null || (typeof v === 'string' && v.trim() === '') || (typeof v === 'number' && !Number.isFinite(v));

export type PassBlockInput = {
  /** E82: what the request still misses (from the board row); the server refuses the pass until it is done. */
  incomplete?: string[] | null;
  /** 'tenant' / 'landlord' at Tenant and Landlord Ops, where an answered call must come first. */
  callDesk: 'tenant' | 'landlord' | null;
  callAnswered: boolean;
  items: Pick<ChecklistItem, 'code' | 'label' | 'required' | 'method' | 'value_kind'>[];
  entries: Record<string, CheckEntry | undefined>;
  /** The system recommends something other than Pass. */
  against: boolean;
  reasonCode: string;
  /** The chosen reason needs a written note (OTHER, RISK_JUDGEMENT, or the code says so). */
  noteRequired: boolean;
  note: string;
  lc1NeedsText?: boolean;
};

export function passBlock(i: PassBlockInput): string | null {
  const missing = (i.incomplete ?? []).filter(Boolean);
  if (missing.length) return `Missing: ${missing.join(', ')}`;
  if (i.callDesk && !i.callAnswered) return `Log an answered ${i.callDesk} call first`;

  const open = i.items.filter((c) => c.required && c.method !== 'system' && !i.entries[c.code]?.result).length;
  if (open > 0) return `Answer ${open} more check${open === 1 ? '' : 's'}`;

  for (const c of i.items) {
    const e = i.entries[c.code];
    if (e?.result !== 'pass' || !needsValue(c, i.lc1NeedsText)) continue;
    const v = e.value;
    const short = c.code === 'sc_lc1_letter' && typeof v === 'string' && v.trim().length < PASS_NOTE_MIN;
    if (empty(v) || short) return VALUE_ASK[c.code] ?? `Fill in "${c.label}"`;
  }

  if (i.against && !i.reasonCode) return 'Choose a reason code';
  if (i.noteRequired && i.note.trim().length < PASS_NOTE_MIN) return `Write at least ${PASS_NOTE_MIN} characters in the note`;
  return null;
}
