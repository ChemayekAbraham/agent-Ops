import type { Dispatch, ReactNode, SetStateAction } from 'react';
import { CALM, FOCUS, LABEL } from './deskTheme';

/**
 * "What must the agent fix?" — required on every desk's send-back (single and
 * bulk): an agent can only fix what is named. The picks go at the start of
 * the note, "[Tenant's face photo, LC1 letter] …", which every send-back RPC
 * records and the agent reads.
 */

export const FIX_ITEMS = [
  "Tenant's face photo",
  'House photos',
  'ID front',
  'ID back',
  'LC1 letter',
  'Landlord',
  'Rent',
  'GPS',
  'Family size',
  'Work',
  'Other',
] as const;
export type FixItem = (typeof FIX_ITEMS)[number];
export const FIX_NOTE_MIN = 10;

/** The note as sent: the items first, then the officer's words. */
export function itemsNote(items: readonly string[], note: string): string {
  const words = note.trim();
  if (items.length === 0) return words;
  return `[${items.join(', ')}]${words ? ` ${words}` : ''}`;
}

/** Why the items stop the send-back, or null: at least one item; "Other" needs a note of 10+ characters. */
export function itemsBlocked(items: readonly string[], note: string): string | null {
  if (items.length === 0) return 'Choose what the agent must fix.';
  if (items.includes('Other') && note.trim().length < FIX_NOTE_MIN) return `Say in the note what "Other" is (at least ${FIX_NOTE_MIN} characters).`;
  return null;
}

/** Keep the picks in the list's order, whatever order they were ticked in. */
export const toggleItem = (items: readonly FixItem[], item: FixItem): FixItem[] =>
  items.includes(item) ? items.filter((i) => i !== item) : FIX_ITEMS.filter((i) => i === item || items.includes(i));

/** A tappable row: at least 44 px tall, the whole width, the label wrapping onto as many lines as it needs. */
export const ROW_CHOICE = 'desk-choice-row flex w-full items-center gap-3 rounded-xl border px-3 py-2 text-left text-sm';
export const ROW_STYLE = { minHeight: 44, borderWidth: 1, borderStyle: 'solid' } as const;
const rowLook = (on: boolean) =>
  on
    ? 'border-[hsl(var(--primary))] bg-[hsl(var(--primary)/0.12)] text-foreground'
    : 'border-[var(--desk-line-color)] bg-[var(--desk-surface)] text-foreground hover:bg-[var(--desk-surface-hover)]';

/** The square that shows a row is ticked (a radio row passes `round`). */
export function Tick({ on, round = false }: { on: boolean; round?: boolean }) {
  return (
    <span
      aria-hidden
      className={`inline-flex shrink-0 items-center justify-center border text-xs font-bold ${on ? 'border-[hsl(var(--primary))] bg-[hsl(var(--primary))] text-[hsl(var(--primary-foreground))]' : 'border-[var(--desk-line-color)]'}`}
      style={{ width: 20, height: 20, borderRadius: round ? 999 : 6, borderWidth: on ? 2 : 1, borderStyle: 'solid' }}
    >
      {on ? '✓' : ''}
    </span>
  );
}

/** A row choice: a checkbox or radio as a full-width, 44 px row with a visible tick when chosen. */
export function ChoiceRow({
  on,
  onClick,
  role,
  children,
  ...data
}: {
  on: boolean;
  onClick: () => void;
  role: 'checkbox' | 'radio';
  children: ReactNode;
} & Record<`data-${string}`, string>) {
  return (
    <button type="button" role={role} aria-checked={on} onClick={onClick} className={`${ROW_CHOICE} ${CALM} ${FOCUS} ${rowLook(on)}`} style={ROW_STYLE} {...data}>
      <Tick on={on} round={role === 'radio'} />
      <span style={{ minWidth: 0, overflowWrap: 'anywhere', whiteSpace: 'normal' }}>{children}</span>
    </button>
  );
}

/** `onChange` is the list's state setter: each tap toggles from the latest list, so quick taps never undo each other. */
export function FixItemsPicker({ value, onChange }: { value: readonly FixItem[]; onChange: Dispatch<SetStateAction<FixItem[]>> }) {
  return (
    <fieldset style={{ border: 0, margin: 0, padding: 0, minWidth: 0 }} data-fix-items>
      <legend className={LABEL} style={{ marginBottom: 6 }}>
        What must the agent fix? (required)
      </legend>
      {/* One full-width row per item: on a phone the labels never squeeze or overlap. */}
      <div role="group" aria-label="What must the agent fix?" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {FIX_ITEMS.map((item) => (
          <ChoiceRow key={item} role="checkbox" on={value.includes(item)} onClick={() => onChange((prev) => toggleItem(prev, item))} data-fix-item={item}>
            {item === 'Other' ? 'Other (needs a note)' : item}
          </ChoiceRow>
        ))}
      </div>
    </fieldset>
  );
}

/**
 * Desk wording (E-wording): "Tenant's face photo", never "passport photo".
 * For text the desks show but do not write themselves (the check catalogue).
 */
export function deskWords(text: string | null | undefined): string {
  if (!text) return text ?? '';
  return text
    .replace(/passport photo is the tenant/gi, "Tenant's face photo shows the tenant")
    .replace(/(the )?(tenant'?s? )?passport[- ]photo/gi, "Tenant's face photo");
}
