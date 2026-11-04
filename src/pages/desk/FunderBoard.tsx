import { fmt } from './format';
import { CALM, LABEL, PANEL, statusGlass, statusText } from './deskTheme';
import { Skeleton } from './Skeleton';
import { readableError, useFunderBoardPreview } from './reviewApi';

/**
 * What the funders would see if this board were published — Partner Ops only.
 *
 * `pipeline_funder_board_preview()` applies the same filter the funder board
 * itself uses (visible to funders, not already taken, photos confirmed by
 * Partner Ops or three or more on file), so this is a rehearsal, not a copy.
 * Nothing on this screen is published and no funder can reach it.
 */

type BoardRow = {
  rent_request_id: string;
  status: string | null;
  tenant_first_name: string | null;
  area: string | null;
  rent_amount: number | null;
  duration_days: number | null;
  photos: number | null;
  score: number | null;
  photos_confirmed_by: string | null;
};

const HEAD = ['Tenant', 'Area', 'Rent (UGX)', 'Days', 'Photos', 'Score', 'Photos confirmed by', 'Stage'];

export function FunderBoard({ board }: { board: boolean }) {
  const preview = useFunderBoardPreview(true);
  const rows = (preview.data ?? []) as unknown as BoardRow[];

  return (
    <section className={`${PANEL} space-y-3 p-4 sm:p-5`}>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="space-y-1">
          <h2 className={`${board ? 'text-lg' : 'text-base'} font-semibold text-foreground`}>
            Funder board — preview
          </h2>
          <p className="max-w-3xl text-xs leading-snug text-muted-foreground">
            Only the first name and the area are ever shown to a Supporter, never the tenant&rsquo;s full name, number or
            address.
          </p>
        </div>
        <span className={`desk-pill border px-3 py-1 text-xs ${statusGlass.warn}`}>Not visible to funders</span>
      </div>

      {preview.isLoading && <Skeleton className="h-40 w-full" />}
      {preview.error && (
        <p className={`text-sm ${statusText.bad}`} role="alert">
          {readableError(preview.error)}
        </p>
      )}

      {!preview.isLoading && !preview.error && rows.length === 0 && (
        <p className="text-sm text-muted-foreground">
          Nothing would appear on the board right now. A request needs clear photos and must still be waiting for a
          funder.
        </p>
      )}

      {rows.length > 0 && (
        <div className="max-h-[32rem] overflow-auto rounded-xl border border-white/10">
          <table className="w-full border-collapse text-sm tabular-nums">
            <thead className="desk-thead">
              <tr>
                {HEAD.map((h, i) => (
                  <th
                    key={h}
                    scope="col"
                    className={`sticky top-0 z-10 border-b border-white/12 px-3 py-2 font-medium text-muted-foreground whitespace-nowrap ${
                      i >= 2 && i <= 5 ? 'text-right' : 'text-left'
                    }`}
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.rent_request_id} className={`desk-row border-b border-white/5 last:border-0 ${CALM}`}>
                  <td className="px-3 py-2 text-foreground">{r.tenant_first_name ?? 'Tenant'}</td>
                  <td className="px-3 py-2 text-foreground">{r.area ?? '—'}</td>
                  <td className="px-3 py-2 text-right text-foreground">{fmt('ugxfull', r.rent_amount)}</td>
                  <td className="px-3 py-2 text-right text-foreground">{fmt('int', r.duration_days)}</td>
                  <td className="px-3 py-2 text-right text-foreground">{fmt('int', r.photos)}</td>
                  <td className="px-3 py-2 text-right text-foreground">{r.score ?? '—'}</td>
                  <td className="px-3 py-2 text-muted-foreground">{r.photos_confirmed_by ?? '—'}</td>
                  <td className="px-3 py-2">
                    <span className={`desk-pill inline-block whitespace-nowrap border px-2.5 py-0.5 text-xs ${statusGlass.idle}`}>
                      {r.status === 'partner_ops_approved' ? 'With the COO' : 'At Partner Ops'}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {rows.length > 0 && (
        <p className={LABEL}>{fmt('int', rows.length)} requests would be on the board.</p>
      )}
    </section>
  );
}
