import { Boxes, Wallet, FileWarning, UserX, PackageCheck } from 'lucide-react';
import { formatUGX } from '@/lib/rentCalculations';
import { useAssetSummary } from '@/hooks/useAssetRegister';
import {
  ASSET_CONDITIONS, ASSET_STATUSES, categoryLabel, type AssetSummary,
} from '@/lib/assetRegister/types';

/**
 * Asset Register overview. Presentation only: every figure comes from `asset_register_summary()`.
 * Register cost is the recorded purchase cost — not a ledger or balance-sheet value.
 */
export function AssetOverview() {
  const q = useAssetSummary();
  const s = q.data;

  if (q.isError) {
    return (
      <div role="alert" className="rounded-xl border border-destructive/30 bg-destructive/10 p-4 text-xs text-destructive">
        Asset overview is unavailable. {isAuthError(q.error) ? 'Your account is not authorised to view the asset register.' : 'Please refresh.'}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-2 xl:grid-cols-4">
        <Tile icon={<Boxes className="h-4 w-4" />} tone="primary" label="Registered assets"
          value={s ? s.total_assets.toLocaleString() : '—'}
          foot={s ? `${s.active_assets.toLocaleString()} active (in use, storage or repair)` : 'Loading…'} />
        <Tile icon={<Wallet className="h-4 w-4" />} tone="success" label="Active register cost (UGX)"
          value={s ? formatUGX(s.active_register_cost_ugx) : '—'}
          foot={s ? `Recorded purchase cost · not a ledger value${s.cost_missing_count ? ` · ${s.cost_missing_count} without cost` : ''}` : 'Loading…'} />
        <Tile icon={<FileWarning className="h-4 w-4" />} tone="warning" label="Missing evidence"
          value={s ? s.missing_evidence_count.toLocaleString() : '—'}
          foot={s ? `${s.missing_photo_count.toLocaleString()} without photo · ${s.missing_serial_count.toLocaleString()} without serial` : 'Loading…'} />
        <Tile icon={<UserX className="h-4 w-4" />} tone="info" label="No custodian"
          value={s ? s.unassigned_count.toLocaleString() : '—'}
          foot={s ? `${(s.by_status.lost ?? 0).toLocaleString()} lost · ${(s.by_status.disposed ?? 0).toLocaleString()} disposed` : 'Loading…'} />
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[1.4fr_1fr] [&>*]:min-w-0">
        <CategoryBreakdown summary={s} />
        <div className="space-y-4">
          <ChipPanel title="By status" list={ASSET_STATUSES} counts={s?.by_status} />
          <ChipPanel title="By condition" list={ASSET_CONDITIONS} counts={s?.by_condition} />
        </div>
      </div>
    </div>
  );
}

function isAuthError(err: unknown) {
  const code = err && typeof err === 'object' && 'code' in err ? (err as { code?: string }).code : undefined;
  return code === '42501';
}

const TONES: Record<string, string> = {
  primary: 'bg-primary/10 text-primary',
  success: 'bg-success/10 text-success',
  warning: 'bg-warning/10 text-warning',
  info: 'bg-info/10 text-info',
};

function Tile({ icon, tone, label, value, foot }: { icon: React.ReactNode; tone: string; label: string; value: string; foot: string }) {
  return (
    <div className="rounded-xl border border-border bg-card p-4 shadow-sm transition-colors hover:border-border/80">
      <div className="flex items-center justify-between gap-2">
        <span className="truncate text-xs font-medium text-muted-foreground">{label}</span>
        <span className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-lg ${TONES[tone]}`}>{icon}</span>
      </div>
      <p className="mt-2.5 truncate text-xl font-bold tabular-nums tracking-tight text-foreground" title={value}>{value}</p>
      <p className="mt-2 truncate border-t border-border/50 pt-2 text-[11px] text-muted-foreground" title={foot}>{foot}</p>
    </div>
  );
}

function CategoryBreakdown({ summary }: { summary?: AssetSummary }) {
  const rows = summary?.by_category ?? [];
  const max = Math.max(1, ...rows.map((r) => r.count));
  return (
    <section className="rounded-xl border border-border bg-card p-4 shadow-sm">
      <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold tracking-tight">
        <PackageCheck className="h-4 w-4 text-primary" /> Assets by category
      </h3>
      {!summary ? (
        <p className="py-6 text-center text-xs text-muted-foreground">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="py-6 text-center text-xs text-muted-foreground">No assets registered yet.</p>
      ) : (
        <ul className="space-y-2.5">
          {rows.map((r) => (
            <li key={r.category} className="text-xs">
              <div className="mb-1 flex items-center justify-between gap-2">
                <span className="truncate font-medium text-foreground">{categoryLabel(r.category)}</span>
                <span className="shrink-0 tabular-nums text-muted-foreground">
                  {r.count.toLocaleString()} · {formatUGX(r.cost_ugx)}
                </span>
              </div>
              <div className="h-1.5 overflow-hidden rounded-full bg-muted">
                <div className="h-full rounded-full bg-primary transition-all duration-500" style={{ width: `${(r.count / max) * 100}%` }} />
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function ChipPanel({ title, list, counts }: {
  title: string;
  list: ReadonlyArray<{ key: string; label: string }>;
  counts?: Partial<Record<string, number>>;
}) {
  return (
    <section className="rounded-xl border border-border bg-card p-4 shadow-sm">
      <h3 className="mb-2.5 text-sm font-semibold tracking-tight">{title}</h3>
      <div className="flex flex-wrap gap-2">
        {list.map((i) => (
          <span key={i.key} className="inline-flex items-center gap-1.5 rounded-full border border-border bg-muted/40 px-2.5 py-1 text-[11px]">
            <span className="text-muted-foreground">{i.label}</span>
            <span className="font-semibold tabular-nums text-foreground">{counts ? (counts[i.key] ?? 0).toLocaleString() : '—'}</span>
          </span>
        ))}
      </div>
    </section>
  );
}
