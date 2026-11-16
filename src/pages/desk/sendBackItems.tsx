import { CALM, FOCUS, LABEL, statusGlass } from './deskTheme';

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

export function FixItemsPicker({ value, onChange }: { value: readonly FixItem[]; onChange: (items: FixItem[]) => void }) {
  return (
    <fieldset style={{ border: 0, margin: 0, padding: 0 }} data-fix-items>
      <legend className={LABEL} style={{ marginBottom: 6 }}>
        What must the agent fix? (required)
      </legend>
      <div role="group" aria-label="What must the agent fix?" style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        {FIX_ITEMS.map((item) => {
          const on = value.includes(item);
          return (
            <button
              key={item}
              type="button"
              role="checkbox"
              aria-checked={on}
              onClick={() => onChange(toggleItem(value, item))}
              data-fix-item={item}
              className={`desk-pill border text-xs ${CALM} ${FOCUS} ${on ? statusGlass.warn : 'border-[var(--desk-line-color)] bg-[var(--desk-surface)] text-muted-foreground hover:text-foreground'}`}
              style={{ display: 'inline-flex', alignItems: 'center', padding: '4px 10px', borderWidth: 1, borderStyle: 'solid', borderRadius: 999 }}
            >
              {on ? '✓ ' : ''}
              {item === 'Other' ? 'Other (needs a note)' : item}
            </button>
          );
        })}
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
