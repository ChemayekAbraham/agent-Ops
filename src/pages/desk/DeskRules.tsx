import { useEffect, useMemo } from 'react';
import { useAuth } from '@/hooks/useAuth';
import { LABEL, statusText } from './deskTheme';
import { EmptyState, ErrorLine, Fold, LoadingRows, stackLayout } from './ui';
import { isMissingDbObject, logMissingOnce } from './deskLive';
import { readableError } from './reviewApi';
import { AutomationBadge, BasisBadge } from './ontology/badges';
import {
  eatTime,
  firstRulesVisit,
  markRulesSeen,
  sortDeskRules,
  useDeskRules,
  type DeskRule,
  type Responsibilities,
} from './ontology/ontologyApi';

/**
 * "Rules for this desk": the ontology rules this desk works under, from
 * `ontology_rules_for_desk(p_desk)`. Read-only and collapsed, after "Done today".
 *
 * An amber dot on the title means a rule changed in the last seven days; the
 * changes are listed first inside. Rules that hold on every desk come last.
 * Hidden while the RPC is not applied, like "Waiting on…".
 *
 * "Your responsibilities" comes first when the desk has them. The fold opens
 * by itself the first time each person visits each desk (remembered in
 * localStorage), so everyone reads them once.
 */

/** The stage desks that carry the section. */
export const RULE_DESKS = new Set(['service-centre', 'agent-ops', 'tenant-ops', 'landlord-ops', 'coo', 'cfo', 'partner-ops', 'customer-care']);

export function RuleLine({ rule }: { rule: DeskRule }) {
  return (
    <li className="flex flex-wrap items-baseline gap-x-2 gap-y-1 py-1.5 text-sm" data-all-desks={rule.all_desks ? 'true' : 'false'}>
      <span className="min-w-0 flex-1 text-foreground">
        <span className="font-mono text-xs">{rule.rule_id}</span> · <span className="text-muted-foreground">When</span> {rule.when ?? '—'}{' '}
        <span className="text-muted-foreground">→ Then</span> {rule.then ?? '—'}
        {rule.all_desks && <span className={`${LABEL} ml-2`}>All desks</span>}
      </span>
      <AutomationBadge automation={rule.automation} />
      <BasisBadge basis={rule.basis} owner={rule.owner} />
    </li>
  );
}

/** The desk's responsibilities: title, role line, numbered steps, what is not allowed, and who answers for it. */
export function ResponsibilitiesBlock({ r }: { r: Responsibilities }) {
  const steps = (r.steps ?? []).filter((s) => String(s ?? '').trim());
  return (
    <section aria-label="Your responsibilities" style={stackLayout(8)}>
      <h3 className="text-sm font-semibold text-foreground" style={{ margin: 0 }}>
        Your responsibilities{r.title ? `: ${r.title}` : ''}
      </h3>
      {r.role_line && (
        <p className="text-sm leading-snug text-foreground" style={{ margin: 0 }}>
          {r.role_line}
        </p>
      )}
      {steps.length > 0 && (
        <ol className="text-sm leading-snug text-foreground" style={{ margin: 0, paddingLeft: 22, listStyleType: 'decimal' }}>
          {steps.map((s, i) => (
            <li key={i} style={{ display: 'list-item', marginTop: i ? 4 : 0 }}>
              {s}
            </li>
          ))}
        </ol>
      )}
      {r.must_not && (
        <p className="text-sm leading-snug" style={{ margin: 0 }}>
          <span className={`font-semibold ${statusText.bad}`}>Not allowed:</span> <span className="text-foreground">{r.must_not}</span>
        </p>
      )}
      {r.accountability && (
        <p
          className="text-sm leading-snug text-foreground border-[hsl(var(--primary)/0.5)] bg-[hsl(var(--primary)/0.10)]"
          data-accountability="true"
          style={{ margin: 0, padding: '10px 14px', borderWidth: 1, borderStyle: 'solid', borderRadius: 14 }}
        >
          {r.accountability}
        </p>
      )}
      {(r.version || r.updated_at) && (
        <p className={LABEL} style={{ margin: 0 }}>
          {r.version ? `Version ${r.version}` : ''}
          {r.version && r.updated_at ? ' · ' : ''}
          {r.updated_at ? `updated ${eatTime(r.updated_at)}` : ''}
        </p>
      )}
    </section>
  );
}

export function DeskRules({ deskId, board }: { deskId: string; board: boolean }) {
  const on = RULE_DESKS.has(deskId);
  const q = useDeskRules(on ? deskId : null);
  const userId = useAuth().user?.id ?? null;
  // Read once per person and desk; marking happens after the first render, so this view still opens.
  const firstVisit = useMemo(() => on && firstRulesVisit(userId, deskId), [on, userId, deskId]);
  useEffect(() => {
    if (firstVisit) markRulesSeen(userId, deskId);
  }, [firstVisit, userId, deskId]);
  if (!on) return null;
  if (q.error && isMissingDbObject(q.error)) {
    logMissingOnce('ontology_rules_for_desk', q.error);
    return null;
  }

  const rules = sortDeskRules(q.data?.rules);
  const changed = q.data?.changed_7d ?? [];
  const resp = q.data?.responsibilities ?? null;

  return (
    <Fold
      key={firstVisit ? 'first' : 'seen'}
      defaultOpen={firstVisit}
      title="Rules for this desk"
      count={q.data ? rules.length : undefined}
      changed={changed.length > 0}
      board={board}
      hint={q.data?.board ? `${q.data.board} board${q.data.version ? ` · ontology ${q.data.version}` : ''}` : 'What the ontology says this desk decides'}
    >
      {q.isLoading ? (
        <LoadingRows rows={2} height={20} label="Loading the rules" />
      ) : q.error ? (
        <ErrorLine>Could not load the rules: {readableError(q.error)}</ErrorLine>
      ) : (
        <div className="space-y-4">
          {resp && <ResponsibilitiesBlock r={resp} />}
          {changed.length > 0 && (
            <div className="space-y-1">
              <h3 className={`text-sm font-semibold ${statusText.warn}`}>Changed this week</h3>
              <ul className="space-y-1 text-sm">
                {changed.map((c, i) => (
                  <li key={`${c.at}-${i}`} className="text-foreground">
                    <span className={`${LABEL} tabular-nums`}>{eatTime(c.at)}</span> · {c.what}
                    {c.why && <span className="text-muted-foreground"> — {c.why}</span>}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {rules.length === 0 ? (
            <EmptyState>No rules recorded for this desk yet.</EmptyState>
          ) : (
            <ul className="divide-y divide-[var(--desk-line-color)]">
              {rules.map((r) => (
                <RuleLine key={r.rule_id} rule={r} />
              ))}
            </ul>
          )}
        </div>
      )}
    </Fold>
  );
}
