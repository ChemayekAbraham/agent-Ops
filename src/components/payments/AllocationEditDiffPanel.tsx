import { ArrowRight, History, MinusCircle, PlusCircle, Equal } from 'lucide-react';
import type { TenantAllocation } from './OperationalFloatTenantAllocator';

/**
 * Edit-mode "Original vs Updated" diff panel for the per-tenant
 * Operational Float breakdown. Renders ONLY when the agent is editing
 * an existing pending deposit (DepositFlow gates this on `isEditMode`)
 * so they can eyeball every shift in tenant amounts — added rows,
 * removed rows, raised amounts, lowered amounts — before saving.
 *
 * Pure presentation: takes two TenantAllocation snapshots and computes
 * the diff inline. No DB writes, no state of its own.
 */

interface Props {
  original: TenantAllocation[];
  updated: TenantAllocation[];
  originalAmount: number | null;
  updatedAmount: number;
}

type RowKind = 'added' | 'removed' | 'raised' | 'lowered' | 'unchanged';

interface DiffRow {
  tenant_id: string;
  tenant_name: string;
  before: number | null;
  after: number | null;
  delta: number; // after - before
  kind: RowKind;
}

function buildDiff(
  original: TenantAllocation[],
  updated: TenantAllocation[],
): DiffRow[] {
  const out: DiffRow[] = [];
  const updatedById = new Map(updated.map((a) => [a.tenant_id, a]));
  const originalById = new Map(original.map((a) => [a.tenant_id, a]));

  // Walk originals first so removed rows surface in a stable position.
  for (const o of original) {
    const u = updatedById.get(o.tenant_id);
    if (!u) {
      out.push({
        tenant_id: o.tenant_id,
        tenant_name: o.tenant_name,
        before: Number(o.amount || 0),
        after: null,
        delta: -Number(o.amount || 0),
        kind: 'removed',
      });
      continue;
    }
    const before = Number(o.amount || 0);
    const after = Number(u.amount || 0);
    const delta = after - before;
    let kind: RowKind = 'unchanged';
    if (Math.abs(delta) > 0.5) kind = delta > 0 ? 'raised' : 'lowered';
    out.push({
      tenant_id: o.tenant_id,
      tenant_name: u.tenant_name || o.tenant_name,
      before,
      after,
      delta,
      kind,
    });
  }
  // Then any newly added rows that weren't in the original.
  for (const u of updated) {
    if (originalById.has(u.tenant_id)) continue;
    out.push({
      tenant_id: u.tenant_id,
      tenant_name: u.tenant_name,
      before: null,
      after: Number(u.amount || 0),
      delta: Number(u.amount || 0),
      kind: 'added',
    });
  }
  return out;
}

const KIND_META: Record<
  RowKind,
  { label: string; tone: string; bg: string; icon: typeof PlusCircle }
> = {
  added: {
    label: 'New',
    tone: 'text-success',
    bg: 'bg-success/10 border-success/30',
    icon: PlusCircle,
  },
  removed: {
    label: 'Removed',
    tone: 'text-destructive',
    bg: 'bg-destructive/10 border-destructive/30',
    icon: MinusCircle,
  },
  raised: {
    label: 'Raised',
    tone: 'text-success',
    bg: 'bg-success/5 border-success/20',
    icon: PlusCircle,
  },
  lowered: {
    label: 'Lowered',
    tone: 'text-warning',
    bg: 'bg-warning/5 border-warning/20',
    icon: MinusCircle,
  },
  unchanged: {
    label: 'Unchanged',
    tone: 'text-muted-foreground',
    bg: 'bg-muted/30 border-border',
    icon: Equal,
  },
};

function fmt(n: number | null): string {
  if (n == null) return '—';
  return `UGX ${Math.round(n).toLocaleString()}`;
}

export function AllocationEditDiffPanel({
  original,
  updated,
  originalAmount,
  updatedAmount,
}: Props) {
  // Nothing to compare against → don't render. Covers the case where
  // edit-mode opened a row that originally had no breakdown payload.
  if (original.length === 0 && updated.length === 0) return null;

  const rows = buildDiff(original, updated);
  const changedRows = rows.filter((r) => r.kind !== 'unchanged');
  const originalSum = original.reduce((s, a) => s + Number(a.amount || 0), 0);
  const updatedSum = updated.reduce((s, a) => s + Number(a.amount || 0), 0);
  const totalDelta = updatedSum - originalSum;
  const amountDelta =
    originalAmount != null ? updatedAmount - originalAmount : 0;
  const noChanges = changedRows.length === 0 && Math.abs(amountDelta) < 0.5;

  return (
    <div className="rounded-lg border border-primary/20 bg-primary/5 p-2.5 space-y-2">
      <div className="flex items-center gap-2">
        <History className="h-3.5 w-3.5 text-primary shrink-0" />
        <p className="text-[11px] font-semibold text-foreground">
          Original vs Updated
        </p>
        <span className="ml-auto text-[10px] text-muted-foreground">
          {noChanges
            ? 'No changes yet'
            : `${changedRows.length} row${changedRows.length === 1 ? '' : 's'} changed`}
        </span>
      </div>

      {/* Deposit total diff */}
      {originalAmount != null && Math.abs(amountDelta) > 0.5 && (
        <div className="rounded-md border border-warning/30 bg-warning/5 px-2 py-1 flex items-center justify-between text-[10px]">
          <span className="text-muted-foreground">Deposit total</span>
          <span className="flex items-center gap-1 font-mono tabular-nums">
            <span className="text-muted-foreground line-through">
              {fmt(originalAmount)}
            </span>
            <ArrowRight className="h-2.5 w-2.5 text-warning" />
            <span className="font-semibold text-foreground">
              {fmt(updatedAmount)}
            </span>
            <span
              className={`ml-1 ${
                amountDelta > 0 ? 'text-success' : 'text-warning'
              }`}
            >
              ({amountDelta > 0 ? '+' : ''}
              {Math.round(amountDelta).toLocaleString()})
            </span>
          </span>
        </div>
      )}

      {/* Per-tenant rows */}
      <ul className="space-y-1">
        {rows.map((r) => {
          const meta = KIND_META[r.kind];
          const Icon = meta.icon;
          return (
            <li
              key={r.tenant_id}
              className={`rounded-md border px-2 py-1 ${meta.bg}`}
            >
              <div className="flex items-center gap-1.5">
                <Icon className={`h-3 w-3 shrink-0 ${meta.tone}`} />
                <span className="text-[11px] font-medium truncate flex-1">
                  {r.tenant_name}
                </span>
                <span
                  className={`text-[9px] uppercase tracking-wide font-semibold ${meta.tone} shrink-0`}
                >
                  {meta.label}
                </span>
              </div>
              <div className="mt-0.5 ml-4.5 flex items-center gap-1 text-[10px] font-mono tabular-nums">
                <span
                  className={
                    r.before == null
                      ? 'text-muted-foreground italic'
                      : 'text-muted-foreground line-through'
                  }
                >
                  {fmt(r.before)}
                </span>
                <ArrowRight className="h-2.5 w-2.5 text-muted-foreground" />
                <span
                  className={
                    r.after == null
                      ? 'text-destructive italic'
                      : 'font-semibold text-foreground'
                  }
                >
                  {fmt(r.after)}
                </span>
                {Math.abs(r.delta) > 0.5 && (
                  <span
                    className={`ml-auto ${
                      r.delta > 0 ? 'text-success' : 'text-warning'
                    }`}
                  >
                    {r.delta > 0 ? '+' : ''}
                    {Math.round(r.delta).toLocaleString()}
                  </span>
                )}
              </div>
            </li>
          );
        })}
      </ul>

      {/* Footer: net allocated change */}
      <div className="border-t border-primary/20 pt-1.5 flex items-center justify-between text-[10px]">
        <span className="text-muted-foreground">Net allocated change</span>
        <span
          className={`font-mono tabular-nums font-semibold ${
            Math.abs(totalDelta) < 0.5
              ? 'text-muted-foreground'
              : totalDelta > 0
                ? 'text-success'
                : 'text-warning'
          }`}
        >
          {totalDelta > 0 ? '+' : ''}
          {Math.round(totalDelta).toLocaleString()} UGX
        </span>
      </div>
    </div>
  );
}

export default AllocationEditDiffPanel;