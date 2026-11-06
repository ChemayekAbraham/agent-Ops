import { useMemo, useState, type ReactNode } from 'react';
import { Check, Copy, Download } from 'lucide-react';
import { CALM, FOCUS, LABEL, PANEL, statusGlass, statusText } from '../deskTheme';
import { Skeleton } from '../Skeleton';
import { Fold } from '../DeskFrame';
import { readableError } from '../reviewApi';
import { isMissingDbObject } from '../deskLive';
import { AutomationBadge, BasisBadge, KindBadge } from './badges';
import {
  CHANGE_WINDOWS,
  LADDER_EMPTY,
  downloadName,
  eatTime,
  followText,
  ladderText,
  rowMatches,
  rulesByBoard,
  useOntologyView,
  versionLabel,
  type ChangeWindow,
  type OntologyView,
} from './ontologyApi';

/**
 * The Ontology tab: the living document, read-only.
 *
 *   header → what changed → decision boards → rules → ready to automate →
 *   open assumptions → registries (collapsed) → copy / download
 *
 * Nothing here edits the ontology; changes land through migrations and show
 * up under "What changed".
 */

const n = (v: number | null | undefined) => Number(v ?? 0).toLocaleString('en');

function Card({ title, hint, board, children }: { title: string; hint?: ReactNode; board: boolean; children: ReactNode }) {
  return (
    <section className={`${PANEL} space-y-3 p-4 sm:p-5`}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className={`${board ? 'text-lg' : 'text-base'} font-semibold text-foreground`}>{title}</h2>
        {hint && <span className={LABEL}>{hint}</span>}
      </div>
      {children}
    </section>
  );
}

function Chip({ children, tone = 'idle' }: { children: ReactNode; tone?: 'idle' | 'ok' | 'bad' | 'warn' }) {
  return <span className={`desk-pill inline-flex items-center border px-2.5 py-0.5 text-xs ${statusGlass[tone]}`}>{children}</span>;
}

function pillButton(active: boolean) {
  return `desk-pill inline-flex items-center gap-1.5 border px-3 py-1.5 text-xs font-medium ${CALM} ${FOCUS} ${
    active
      ? 'border-[hsl(var(--primary)/0.6)] bg-[hsl(var(--primary)/0.18)] text-foreground'
      : 'border-[var(--desk-line-color)] bg-[var(--desk-surface)] text-muted-foreground hover:bg-[var(--desk-surface-hover)] hover:text-foreground'
  }`;
}

function Header({ view, days, setDays, board }: { view: OntologyView; days: ChangeWindow; setDays: (d: ChangeWindow) => void; board: boolean }) {
  const c = view.counts;
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <p className={`${board ? 'text-xl' : 'text-base sm:text-lg'} font-medium text-foreground`}>
        Ontology {versionLabel(view.version)} · {n(c?.objects)} objects · {n(c?.links)} links · {n(c?.actions)} actions · {n(c?.boards)} boards ·{' '}
        {n(c?.rules)} rules ({n(c?.assumptions)} assumptions)
      </p>
      <div role="group" aria-label="What changed: window" className="flex items-center gap-1.5">
        <span className={LABEL}>What changed in</span>
        {CHANGE_WINDOWS.map((d) => (
          <button key={d} type="button" aria-pressed={days === d} onClick={() => setDays(d)} className={pillButton(days === d)}>
            {d} days
          </button>
        ))}
      </div>
    </div>
  );
}

function WhatChanged({ view, days, board }: { view: OntologyView; days: ChangeWindow; board: boolean }) {
  const changes = view.week?.changes ?? [];
  const added = view.week?.added ?? [];
  const retired = view.week?.retired ?? [];
  return (
    <Card title="What changed" board={board} hint={view.week?.since ? `Since ${eatTime(view.week.since)}` : `Last ${days} days`}>
      {changes.length === 0 ? (
        <p className="text-sm text-muted-foreground">Nothing changed in the last {days} days.</p>
      ) : (
        <ul className="divide-y divide-[var(--desk-line-color)]">
          {changes.map((ch, i) => (
            <li key={`${ch.at}-${i}`} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 py-2 text-sm">
              <span className={`${LABEL} w-32 shrink-0 tabular-nums`}>{eatTime(ch.at)}</span>
              <KindBadge kind={ch.kind} />
              <span className="min-w-0 flex-1 text-foreground">
                {ch.what}
                {ch.why && <span className="text-muted-foreground"> — {ch.why}</span>}
              </span>
              {ch.by && <span className="font-mono text-xs text-muted-foreground">{ch.by}</span>}
            </li>
          ))}
        </ul>
      )}
      {(added.length > 0 || retired.length > 0) && (
        <div className="flex flex-wrap items-center gap-1.5">
          {added.map((a, i) => (
            <Chip key={`a-${a.kind}-${a.name}-${i}`} tone="ok">
              Added: {a.kind} {a.name}
            </Chip>
          ))}
          {retired.map((r, i) => (
            <Chip key={`r-${r.kind}-${r.name}-${i}`} tone="bad">
              Retired: {r.kind} {r.name}
              {r.now ? ` → ${r.now}` : ''}
            </Chip>
          ))}
        </div>
      )}
    </Card>
  );
}

function Boards({ view, board }: { view: OntologyView; board: boolean }) {
  const boards = [...(view.boards ?? [])].sort((a, b) => a.ord - b.ord);
  return (
    <Card title="Decision boards" board={board} hint="In pipeline order">
      {boards.length === 0 ? (
        <p className="text-sm text-muted-foreground">No boards recorded.</p>
      ) : (
        <div className="-mx-1 flex snap-x gap-3 overflow-x-auto px-1 pb-2">
          {boards.map((b) => {
            const overrides = b.follow?.top_overrides ?? [];
            return (
              <article key={`${b.ord}-${b.name}`} className="desk-tile w-72 shrink-0 snap-start space-y-2 p-3.5">
                <div className="flex items-baseline gap-2">
                  <span className={`${LABEL} tabular-nums`}>{b.ord}</span>
                  <h3 className="font-semibold text-foreground">{b.name}</h3>
                </div>
                {b.purpose && <p className="text-sm leading-snug text-muted-foreground">{b.purpose}</p>}
                {(b.actions ?? []).length > 0 && (
                  <div className="flex flex-wrap gap-1">
                    {(b.actions ?? []).map((a) => (
                      <Chip key={a}>{a}</Chip>
                    ))}
                  </div>
                )}
                <p className="text-sm text-foreground">{followText(b.follow)}</p>
                {overrides.length > 0 && (
                  <p className="text-xs text-muted-foreground">
                    Top overrides: {overrides.map((o) => `${o.reason_code} (${n(o.n)})`).join(', ')}
                  </p>
                )}
              </article>
            );
          })}
        </div>
      )}
    </Card>
  );
}

function Rules({ view, board }: { view: OntologyView; board: boolean }) {
  const groups = rulesByBoard(view.rules, view.boards);
  return (
    <Card title="Rules" board={board} hint="Grouped by board">
      {groups.length === 0 && <p className="text-sm text-muted-foreground">No rules recorded.</p>}
      {groups.map((g) => (
        <div key={g.board} className="space-y-1">
          <h3 className={`${LABEL} font-semibold`}>{g.board}</h3>
          <ul className="divide-y divide-[var(--desk-line-color)]">
            {g.rules.map((r) => (
              <li key={r.rule_id} className="flex flex-wrap items-baseline gap-x-2 gap-y-1 py-1.5 text-sm">
                <span className="font-mono text-xs text-foreground">{r.rule_id}</span>
                <span className="min-w-0 flex-1 text-foreground">
                  <span className="text-muted-foreground">When</span> {r.condition ?? '—'} <span className="text-muted-foreground">→ Then</span>{' '}
                  {r.decision ?? '—'}
                </span>
                <AutomationBadge automation={r.automation} />
                <BasisBadge basis={r.basis} owner={r.owner} />
              </li>
            ))}
          </ul>
        </div>
      ))}
    </Card>
  );
}

function Ladder({ view, board }: { view: OntologyView; board: boolean }) {
  const list = view.week?.ladder_candidates ?? [];
  return (
    <Card title="Ready to automate" board={board}>
      {list.length === 0 ? (
        <p className="text-sm text-muted-foreground">{LADDER_EMPTY}</p>
      ) : (
        <ul className="space-y-1 text-sm text-foreground">
          {list.map((c) => (
            <li key={`${c.rule_id}-${c.to}`}>
              {ladderText(c)}
              {c.board && <span className="text-muted-foreground"> · {c.board}</span>}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function Assumptions({ view, board }: { view: OntologyView; board: boolean }) {
  const list = view.assumptions ?? [];
  return (
    <Card title="Open assumptions" board={board} hint="Each owner confirms the decision before it counts as one">
      {list.length === 0 ? (
        <p className="text-sm text-muted-foreground">No open assumptions.</p>
      ) : (
        <ul className="divide-y divide-[var(--desk-line-color)]">
          {list.map((a) => (
            <li key={a.rule_id} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 py-2 text-sm">
              <span className="font-mono text-xs text-foreground">{a.rule_id}</span>
              <span className={`${statusText.warn} text-xs font-medium`}>{a.owner ?? 'No owner'}</span>
              <span className="min-w-0 flex-1 text-foreground">
                {a.decision ?? '—'}
                {a.notes && <span className="text-muted-foreground"> — {a.notes}</span>}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

type Col<T> = { label: string; get: (r: T) => ReactNode; mono?: boolean };

function SearchTable<T extends Record<string, unknown>>({ title, rows, cols, board }: { title: string; rows: T[]; cols: Col<T>[]; board: boolean }) {
  return (
    <Fold title={`${title} (${rows.length})`} board={board}>
      <SearchTableBody title={title} rows={rows} cols={cols} />
    </Fold>
  );
}

function SearchTableBody<T extends Record<string, unknown>>({ title, rows, cols }: { title: string; rows: T[]; cols: Col<T>[] }) {
  const [q, setQ] = useState('');
  const shown = useMemo(() => rows.filter((r) => rowMatches(r, q)), [rows, q]);
  return (
    <div className="space-y-2">
      <input
        type="search"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder={`Search ${title.toLowerCase()}`}
        aria-label={`Search ${title.toLowerCase()}`}
        className={`w-full max-w-sm rounded border border-[var(--desk-line-color)] bg-[var(--desk-surface)] px-3 py-1.5 text-sm text-foreground ${FOCUS}`}
      />
      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead className="desk-thead">
            <tr>
              {cols.map((c) => (
                <th key={c.label} className={`${LABEL} whitespace-nowrap px-2 py-1.5 font-medium`}>
                  {c.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {shown.map((r, i) => (
              <tr key={i} className="desk-row border-t border-[var(--desk-line-color)] align-top">
                {cols.map((c) => (
                  <td key={c.label} className={`px-2 py-1.5 text-foreground ${c.mono ? 'font-mono text-xs' : ''}`}>
                    {c.get(r) ?? '—'}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        {shown.length === 0 && <p className="py-2 text-sm text-muted-foreground">{q ? 'No match.' : 'Nothing recorded.'}</p>}
      </div>
    </div>
  );
}

const list = (v: string[] | null | undefined) => (v && v.length ? v.join(', ') : '—');

function Registries({ view, board }: { view: OntologyView; board: boolean }) {
  return (
    <div>
      <SearchTable
        title="Objects"
        board={board}
        rows={view.objects ?? []}
        cols={[
          { label: 'Name', get: (r) => r.name, mono: true },
          { label: 'Family', get: (r) => r.family },
          { label: 'Source of truth', get: (r) => r.sot, mono: true },
          { label: 'Description', get: (r) => r.description },
          { label: 'Status', get: (r) => r.status },
          { label: 'Since', get: (r) => r.since_version },
        ]}
      />
      <SearchTable
        title="Links"
        board={board}
        rows={view.links ?? []}
        cols={[
          { label: 'Name', get: (r) => r.name, mono: true },
          { label: 'From → To', get: (r) => `${r.from_object ?? '—'} → ${r.to_object ?? '—'}` },
          { label: 'Via', get: (r) => r.via, mono: true },
          { label: 'Meaning', get: (r) => r.meaning },
          { label: 'Status', get: (r) => r.status },
          { label: 'Since', get: (r) => r.since_version },
        ]}
      />
      <SearchTable
        title="Actions"
        board={board}
        rows={view.actions ?? []}
        cols={[
          { label: 'Name', get: (r) => r.name, mono: true },
          { label: 'Object', get: (r) => r.object_type },
          { label: 'From → To', get: (r) => `${list(r.from_states)} → ${r.to_state ?? '—'}` },
          { label: 'Owner desk', get: (r) => r.owner_desk },
          { label: 'Evidence', get: (r) => r.evidence_column, mono: true },
          { label: 'Status', get: (r) => r.status },
          { label: 'Since', get: (r) => r.since_version },
        ]}
      />
      <SearchTable
        title="Reason codes"
        board={board}
        rows={view.reason_codes ?? []}
        cols={[
          { label: 'Code', get: (r) => r.code, mono: true },
          { label: 'Desks', get: (r) => list(r.desks) },
          { label: 'Meaning', get: (r) => r.meaning },
          { label: 'Needs text', get: (r) => (r.requires_text ? 'Yes' : 'No') },
          { label: 'Status', get: (r) => r.status },
        ]}
      />
      <SearchTable
        title="Jobs"
        board={board}
        rows={view.jobs ?? []}
        cols={[
          { label: 'Ref', get: (r) => r.ref, mono: true },
          { label: 'Kind', get: (r) => r.kind },
          { label: 'Owner', get: (r) => r.owner },
          { label: 'Purpose', get: (r) => r.purpose },
          { label: 'Status', get: (r) => r.status },
        ]}
      />
      <SearchTable
        title="Switches"
        board={board}
        rows={view.switches ?? []}
        cols={[
          { label: 'Key', get: (r) => r.key, mono: true },
          { label: 'State', get: (r) => (r.is_on === null ? '—' : r.is_on ? 'On' : 'Off') },
          { label: 'Note', get: (r) => r.note },
          { label: 'Changed', get: (r) => eatTime(r.changed_at) },
        ]}
      />
    </div>
  );
}

function Export({ view }: { view: OntologyView }) {
  const [copied, setCopied] = useState<'idle' | 'ok' | 'failed'>('idle');
  const md = view.document_md ?? '';

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(md);
      setCopied('ok');
    } catch {
      setCopied('failed');
    }
    window.setTimeout(() => setCopied('idle'), 2500);
  };

  const download = () => {
    const url = URL.createObjectURL(new Blob([md], { type: 'text/markdown;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = downloadName(view.version);
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="flex flex-wrap items-center gap-2 border-t border-[var(--desk-line-color)] pt-3">
      <button type="button" onClick={copy} disabled={!md} className={pillButton(false)}>
        {copied === 'ok' ? <Check className="h-3.5 w-3.5" aria-hidden /> : <Copy className="h-3.5 w-3.5" aria-hidden />}
        {copied === 'ok' ? 'Copied' : 'Copy as Markdown'}
      </button>
      <button type="button" onClick={download} disabled={!md} className={pillButton(false)}>
        <Download className="h-3.5 w-3.5" aria-hidden /> Download .md
      </button>
      {copied === 'failed' && <span className={`text-xs ${statusText.bad}`}>Could not copy — use Download instead.</span>}
      {view.generated_at && <span className={LABEL}>Generated {eatTime(view.generated_at)}</span>}
    </div>
  );
}

export function OntologyTab({ board }: { board: boolean }) {
  const [days, setDays] = useState<ChangeWindow>(7);
  const q = useOntologyView(days);

  if (q.isLoading) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-6 w-3/4" />
        <Skeleton className="h-32 w-full" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }
  if (q.error || !q.data) {
    const missing = isMissingDbObject(q.error);
    return (
      <p className={`text-sm ${statusText.bad}`}>
        {missing ? 'The ontology view is not available yet.' : `Could not load the ontology: ${readableError(q.error)}`}
      </p>
    );
  }

  const view = q.data;
  return (
    <div className="space-y-5" aria-busy={q.isFetching}>
      <Header view={view} days={days} setDays={setDays} board={board} />
      <WhatChanged view={view} days={days} board={board} />
      <Boards view={view} board={board} />
      <Rules view={view} board={board} />
      <Ladder view={view} board={board} />
      <Assumptions view={view} board={board} />
      <Registries view={view} board={board} />
      <Export view={view} />
    </div>
  );
}
