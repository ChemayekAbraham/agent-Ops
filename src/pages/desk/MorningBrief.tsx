import { useMorningBrief } from './deskBriefApi';
import { LABEL, PANEL } from './deskTheme';

/**
 * "Today on Welile" — the three sentences the desks open on.
 *
 * The server writes the sentences; this only lays them out. Three rules from
 * the brief itself: never show a zero while loading (a zero reads as a fact),
 * never show more than three lines, and never break the page on an error —
 * a desk with no brief is still a working desk, so the card simply goes.
 */
export function MorningBrief({ board, enabled }: { board: boolean; enabled: boolean }) {
  const q = useMorningBrief(enabled);

  if (!enabled) return null;
  // An error here is not worth a red panel: the rest of the page carries the numbers.
  if (q.error) return null;

  const clauses = (q.data?.clauses ?? []).filter((c) => typeof c === 'string' && c.trim()).slice(0, 3);
  if (!q.isLoading && clauses.length === 0) return null;

  return (
    <section className={`${PANEL} space-y-2 p-4 sm:p-5`} aria-label="Today on Welile" aria-busy={q.isLoading}>
      <h2 className={`${board ? 'text-lg' : 'text-base'} font-semibold text-foreground`}>Today on Welile</h2>

      {q.isLoading ? (
        <p className={`${board ? 'text-base' : 'text-sm'} text-muted-foreground`}>Loading…</p>
      ) : (
        <ol className="space-y-1.5">
          {clauses.map((c, i) => (
            <li
              key={i}
              className={`${board ? 'text-base' : 'text-sm'} leading-snug text-foreground`}
            >
              {c}
            </li>
          ))}
        </ol>
      )}

      {!q.isLoading && q.data?.generated_at && (
        <p className={LABEL}>
          As at{' '}
          {new Date(q.data.generated_at).toLocaleTimeString('en-GB', {
            timeZone: 'Africa/Kampala',
            hour: '2-digit',
            minute: '2-digit',
          })}{' '}
          Kampala · refreshes every 5 minutes
        </p>
      )}
    </section>
  );
}
