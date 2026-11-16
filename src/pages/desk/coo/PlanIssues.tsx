import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { rpc } from '../reviewApi';
import { LABEL, statusText } from '../deskTheme';
import { fmt } from '../format';
import { Card, DecisionButton, EmptyState, ErrorLine, LoadingRows, moneyFull, stackLayout } from '../ui';
import { plainError } from '../arrears/arrearsApi';
import { CallButtons, dayText } from '../arrears/ArrearsParts';

/**
 * PLAN-INTEGRITY (E126): plans whose terms are broken or whose closing does
 * not add up, from `plan_integrity_issues()`. The COO / CEO push each to the
 * CFO (`plan_integrity_push`), who gets a 'cfo_plan_review' notification; the
 * CFO desk sees the same card without the push.
 */

export type PlanIssueKind = 'repaying_no_terms' | 'completed_underpaid';
export type PlanIssue = {
  rent_request_id: string;
  ref: string;
  kind: PlanIssueKind | string;
  problem: string | null;
  status: string | null;
  tenant: { name: string | null; phone: string | null } | null;
  agent: { name: string | null; phone: string | null } | null;
  rent: number | null;
  daily: number | null;
  total: number | null;
  repaid: number | null;
  gap: number | null;
  funded_at: string | null;
  pushed: { at: string | null; by: string | null; note: string | null } | null;
};

export const KIND_GROUPS: { kind: PlanIssueKind; title: string }[] = [
  { kind: 'repaying_no_terms', title: 'Repaying with no terms' },
  { kind: 'completed_underpaid', title: 'Completed but underpaid' },
];
export const PLAN_ISSUES_KEY = ['desk-feed', 'plan-integrity'] as const;
export const PUSH_WORDS: Record<string, string> = {
  COO_ONLY: 'Only the COO or the CEO can push plan issues to the CFO.',
  NO_ISSUE: 'This plan no longer has a set-up issue, so there is nothing to push.',
  NOT_FOUND: 'That plan could not be found.',
};

export function usePlanIssues() {
  return useQuery({
    queryKey: PLAN_ISSUES_KEY,
    queryFn: async () => {
      const { data, error } = await rpc('plan_integrity_issues');
      if (error) throw error;
      const d = (data ?? {}) as { items?: PlanIssue[]; rule?: string };
      return { items: Array.isArray(d.items) ? d.items : [], rule: d.rule ?? null };
    },
    staleTime: 60_000,
    retry: 1,
  });
}

const when = (v: string | null | undefined) =>
  v && Number.isFinite(Date.parse(v)) ? new Date(v).toLocaleString('en-GB', { timeZone: 'Africa/Kampala', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—';

/** The plan's push to the CFO: an optional note, then one call; the server's refusals in plain words. */
function PushToCfo({ item }: { item: PlanIssue }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const label = item.pushed ? 'Push again' : 'Push to CFO';

  const push = async () => {
    setBusy(true);
    setProblem(null);
    const { data, error } = await rpc('plan_integrity_push', { p_request_id: item.rent_request_id, p_note: note.trim() || null });
    setBusy(false);
    if (error) return setProblem(plainError(error, PUSH_WORDS));
    const n = Number((data as { cfo_notified?: number } | null)?.cfo_notified ?? 0);
    toast.success(`Pushed to the CFO${n > 0 ? ` (${n} notified)` : ''}`);
    setOpen(false);
    setNote('');
    void qc.invalidateQueries({ queryKey: [...PLAN_ISSUES_KEY] });
  };

  if (!open) {
    return (
      <div style={stackLayout(4)}>
        <div>
          <DecisionButton variant={item.pushed ? 'quiet' : 'primary'} onClick={() => setOpen(true)} data-push-cfo={item.ref}>
            {label}
          </DecisionButton>
        </div>
        {problem && <ErrorLine>{problem}</ErrorLine>}
      </div>
    );
  }
  return (
    <div style={stackLayout(6)} data-push-form={item.ref}>
      <textarea
        value={note}
        onChange={(e) => setNote(e.target.value)}
        rows={2}
        placeholder="Note for the CFO (optional)"
        aria-label={`Note for the CFO about ${item.ref}`}
        className="rounded-md border border-[var(--desk-line-color)] bg-[var(--desk-surface)] px-2 py-1.5 text-sm text-foreground"
      />
      {problem && <ErrorLine>{problem}</ErrorLine>}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        <DecisionButton variant="primary" disabled={busy} onClick={() => void push()}>
          {busy ? 'Pushing…' : `${label} · ${item.ref}`}
        </DecisionButton>
        <DecisionButton variant="quiet" onClick={() => setOpen(false)}>
          Cancel
        </DecisionButton>
      </div>
    </div>
  );
}

function IssueRow({ item, canPush }: { item: PlanIssue; canPush: boolean }) {
  return (
    <li className="desk-panel min-w-0" style={{ ...stackLayout(8), padding: 12 }} data-plan-issue={item.ref} data-kind={item.kind}>
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'baseline', justifyContent: 'space-between', gap: 8 }}>
        <span className="font-mono text-xs text-muted-foreground">{item.ref}</span>
        <span className={LABEL}>Funded {dayText(item.funded_at)}</span>
      </div>
      {item.kind === 'completed_underpaid' ? (
        <p className="text-sm text-foreground" style={{ margin: 0 }} data-plan-money>
          Repaid {moneyFull(item.repaid)} of {moneyFull(item.total)} · gap <span className={`font-semibold ${statusText.bad}`}>{moneyFull(item.gap)}</span>
        </p>
      ) : (
        <p className={`text-sm ${statusText.warn}`} style={{ margin: 0 }} data-plan-problem>
          {item.problem ?? 'Repaying, but the plan has no terms'}
        </p>
      )}
      <div style={stackLayout(6)}>
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
          <span className="text-sm" style={{ overflowWrap: 'anywhere' }}>
            <span className={LABEL}>Tenant </span>
            <span className="font-medium text-foreground">{item.tenant?.name ?? '—'}</span>
          </span>
          <CallButtons phone={item.tenant?.phone ?? null} who={`tenant ${item.tenant?.name ?? ''}`.trim()} />
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
          <span className="text-sm" style={{ overflowWrap: 'anywhere' }}>
            <span className={LABEL}>Agent </span>
            <span className="text-foreground">{item.agent?.name ?? '—'}</span>
          </span>
          <CallButtons phone={item.agent?.phone ?? null} who={`agent ${item.agent?.name ?? ''}`.trim()} />
        </div>
      </div>
      {item.pushed && (
        <p className={`text-sm ${statusText.ok}`} style={{ margin: 0 }} data-pushed>
          Pushed {when(item.pushed.at)} by {item.pushed.by ?? 'staff'}
          {item.pushed.note ? <span className={LABEL}> — {item.pushed.note}</span> : null}
        </p>
      )}
      {canPush && <PushToCfo item={item} />}
    </li>
  );
}

/** The card on the CFO's home (/cfo): read-only, inside the desks' colour scope in the app's light or dark theme. */
export function CfoPlanIssues() {
  const dark = typeof document !== 'undefined' && document.documentElement.classList.contains('dark');
  return (
    <div className="desk-root" data-desk-theme={dark ? 'dark' : 'light'} data-cfo-plan-issues>
      <PlanIssuesCard board={false} canPush={false} />
    </div>
  );
}

/**
 * "Plan set-up issues". `canPush` on the Command Centre; the CFO desk reads
 * the same card without the push. A viewer the server refuses sees nothing.
 */
export function PlanIssuesCard({ board, canPush }: { board: boolean; canPush: boolean }) {
  const q = usePlanIssues();
  const refused = (q.error as { code?: string; message?: string } | null)?.code === '42501' || /^PLAN_ISSUES_DENIED/.test(String((q.error as { message?: string } | null)?.message ?? ''));
  if (refused) return null;
  const items = q.data?.items ?? [];
  // The header's total: the sum of the gaps the server sent.
  const totalGap = items.reduce((s, i) => s + (Number(i.gap) || 0), 0);
  return (
    <Card
      board={board}
      title="Plan set-up issues"
      hint={q.data ? <span data-total-gap>Total gap {moneyFull(totalGap)}</span> : undefined}
      ariaLabel="Plan set-up issues"
      busy={q.isLoading}
      footnote={q.data?.rule ?? undefined}
    >
      {q.isLoading ? (
        <LoadingRows rows={3} label="Loading plan set-up issues" />
      ) : q.error ? (
        <ErrorLine>{plainError(q.error)}</ErrorLine>
      ) : items.length === 0 ? (
        <EmptyState>No plan set-up issues.</EmptyState>
      ) : (
        <div style={stackLayout(14)}>
          {KIND_GROUPS.map((g) => {
            const rows = items.filter((i) => i.kind === g.kind);
            if (rows.length === 0) return null;
            return (
              <section key={g.kind} aria-label={g.title} data-issue-group={g.kind} style={stackLayout(8)}>
                <h3 className="text-sm font-semibold text-foreground" style={{ margin: 0 }}>
                  {g.title} <span className="tabular-nums text-muted-foreground">({fmt('int', rows.length)})</span>
                </h3>
                <ul style={{ ...stackLayout(8), margin: 0, padding: 0, listStyle: 'none' }}>
                  {rows.map((i) => (
                    <IssueRow key={i.rent_request_id} item={i} canPush={canPush} />
                  ))}
                </ul>
              </section>
            );
          })}
        </div>
      )}
    </Card>
  );
}
