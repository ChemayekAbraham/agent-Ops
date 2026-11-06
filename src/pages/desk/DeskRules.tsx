import { Fold } from './DeskFrame';
import { LABEL, statusDot, statusText } from './deskTheme';
import { Skeleton } from './Skeleton';
import { isMissingDbObject, logMissingOnce } from './deskLive';
import { readableError } from './reviewApi';
import { AutomationBadge, BasisBadge } from './ontology/badges';
import { eatTime, sortDeskRules, useDeskRules, type DeskRule } from './ontology/ontologyApi';

/**
 * "Rules for this desk": the ontology rules this desk works under, from
 * `ontology_rules_for_desk(p_desk)`. Read-only and collapsed, after "Done today".
 *
 * An amber dot on the title means a rule changed in the last seven days; the
 * changes are listed first inside. Rules that hold on every desk come last.
 * Hidden while the RPC is not applied, like "Waiting on…".
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

export function DeskRules({ deskId, board }: { deskId: string; board: boolean }) {
  const on = RULE_DESKS.has(deskId);
  const q = useDeskRules(on ? deskId : null);
  if (!on) return null;
  if (q.error && isMissingDbObject(q.error)) {
    logMissingOnce('ontology_rules_for_desk', q.error);
    return null;
  }

  const rules = sortDeskRules(q.data?.rules);
  const changed = q.data?.changed_7d ?? [];
  const title = q.data ? `Rules for this desk (${rules.length})` : 'Rules for this desk';

  return (
    <Fold
      title={title}
      board={board}
      badge={
        changed.length > 0 ? (
          <span className={`h-2 w-2 rounded-full ${statusDot.warn}`} role="img" aria-label="Changed this week" title="Changed this week" />
        ) : undefined
      }
      hint={q.data?.board ? `${q.data.board} board${q.data.version ? ` · ontology ${q.data.version}` : ''}` : 'What the ontology says this desk decides'}
    >
      {q.isLoading ? (
        <Skeleton className="h-5 w-72" />
      ) : q.error ? (
        <p className={`text-sm ${statusText.bad}`}>Could not load the rules: {readableError(q.error)}</p>
      ) : (
        <div className="space-y-4">
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
            <p className="text-sm text-muted-foreground">No rules recorded for this desk yet.</p>
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
