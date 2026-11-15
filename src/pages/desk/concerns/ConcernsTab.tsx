import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { CALM, FOCUS, LABEL, statusGlass, statusText } from '../deskTheme';
import { readableError } from '../reviewApi';
import { isDenied } from '../accountability/accountabilityApi';
import { Card, Chip, DataList, ErrorLine, LoadingRows, Segmented, stackLayout, type DataColumn } from '../ui';
import { Explain } from '../cooBadges';
import {
  ageText,
  filterRows,
  kampalaDay,
  linkTarget,
  ugxFull,
  useConcernsQueue,
  type ConcernRow,
  type ConcernsScope,
} from './concernsQueueApi';

/**
 * Command Centre → Concerns (E64 queue). Totals on top, a chip per source
 * (tap to filter), "Where it's parked", then the rows money-first as the
 * server orders them: a table from md, cards below. A tap on a row opens its
 * link_path; the source and Overdue badges explain themselves with the desks'
 * Explain panel — as a sheet at every width, since a table cell would clip a popover.
 */

function Figure({ label, value, tone }: { label: string; value: string; tone?: 'bad' }) {
  return (
    <div style={{ ...stackLayout(2), minWidth: 0 }}>
      <span className={LABEL}>{label}</span>
      <span className={`text-2xl font-bold tabular-nums ${tone === 'bad' ? statusText.bad : 'text-foreground'}`} data-figure={label}>
        {value}
      </span>
    </div>
  );
}

const pill = (on: boolean) =>
  `desk-pill border px-3 text-sm ${CALM} ${FOCUS} ${
    on ? 'border-[hsl(var(--primary)/0.6)] bg-[hsl(var(--primary)/0.18)] text-foreground' : 'border-[var(--desk-line-color)] bg-[var(--desk-surface)] text-muted-foreground hover:bg-[var(--desk-surface-hover)] hover:text-foreground'
  }`;
const PILL_STYLE = { minHeight: 44, display: 'inline-flex', alignItems: 'center', gap: 6, borderWidth: 1, borderStyle: 'solid' as const };

/** The source badge on a row: what it is, who owns it, where it is parked. */
function SourceBadge({ r }: { r: ConcernRow }) {
  return (
    <Explain sheet label={`${r.source_label}: about this concern`} badge={<Chip tone="idle">{r.source_label}</Chip>}>
      <span className="text-sm font-semibold text-foreground">{r.title}</span>
      {r.about && <span className="text-sm text-foreground">{r.about}</span>}
      <span className={LABEL}>
        {[r.ref, r.owner_name ? `Owner: ${r.owner_name}` : 'No owner yet', r.parked_at ? `Parked at ${r.parked_at}` : null, r.status].filter(Boolean).join(' · ')}
      </span>
      <span className={LABEL}>
        Opened {kampalaDay(r.opened_at)} · {ageText(r.age_days)} old
      </span>
    </Explain>
  );
}

/** The red "Overdue" badge: when it was due and how long it has been open. */
function OverdueBadge({ r }: { r: ConcernRow }) {
  return (
    <Explain sheet label="Overdue: what it means" badge={<Chip tone="bad" strong>Overdue</Chip>}>
      <span className="text-sm text-foreground">Due {kampalaDay(r.due_at)} and still open.</span>
      <span className={LABEL}>
        Opened {kampalaDay(r.opened_at)}, {ageText(r.age_days)} ago{r.owner_name ? ` · owner ${r.owner_name}` : ''}.
      </span>
    </Explain>
  );
}

export function ConcernsTab({ board }: { board: boolean }) {
  const navigate = useNavigate();
  const [scope, setScope] = useState<ConcernsScope>('open');
  const [source, setSource] = useState<string | null>(null);
  const [overdueOnly, setOverdueOnly] = useState(false);
  const q = useConcernsQueue(scope, source);
  // The source chips always come from the unfiltered queue, so picking one never hides the others.
  const all = useConcernsQueue(scope, null, source !== null);
  const sources = (source ? all.data?.by_source : q.data?.by_source) ?? [];

  if (q.error && isDenied(q.error)) return <ErrorLine>You are not allowed to see the Concerns queue.</ErrorLine>;
  if (q.data === null) return <ErrorLine>The Concerns queue is not available yet.</ErrorLine>;
  const d = q.data;
  const rows = d ? filterRows(d.rows, overdueOnly) : [];

  const open = (r: ConcernRow) => {
    const t = linkTarget(r.link_path);
    if (!t) return;
    if (t.internal) navigate(t.href);
    else window.open(t.href, '_blank', 'noopener,noreferrer');
  };

  const columns: DataColumn<ConcernRow>[] = [
    {
      key: 'title',
      label: 'Concern',
      priority: 1,
      kind: 'name',
      text: (r) => r.title,
      render: (r) => (
        <span style={{ ...stackLayout(2), minWidth: 0 }}>
          <span className="font-medium text-foreground" style={{ overflowWrap: 'anywhere', whiteSpace: 'normal' }}>
            {r.title}
          </span>
          {r.about && <span className={LABEL} style={{ whiteSpace: 'normal' }}>{r.about}</span>}
        </span>
      ),
    },
    { key: 'source', label: 'Source', priority: 1, kind: 'chips', text: (r) => r.source_label, render: (r) => <SourceBadge r={r} /> },
    {
      key: 'due',
      label: 'Due',
      priority: 1,
      kind: 'date',
      minWidth: 112,
      text: (r) => kampalaDay(r.due_at),
      render: (r) => (
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
          <span className="tabular-nums" style={{ whiteSpace: 'nowrap' }}>{kampalaDay(r.due_at)}</span>
          {r.overdue && <OverdueBadge r={r} />}
        </span>
      ),
    },
    { key: 'money', label: 'Money', priority: 2, kind: 'money', minWidth: 130, text: (r) => ugxFull(r.money_ugx) ?? '', render: (r) => <span className="tabular-nums font-semibold" style={{ whiteSpace: 'nowrap' }}>{ugxFull(r.money_ugx) ?? '—'}</span> },
    { key: 'owner', label: 'Owner', priority: 2, kind: 'text', minWidth: 130, text: (r) => r.owner_name ?? '', render: (r) => r.owner_name ?? '—' },
    { key: 'age', label: 'Age', priority: 2, kind: 'number', minWidth: 84, text: (r) => ageText(r.age_days), render: (r) => <span className="tabular-nums" style={{ whiteSpace: 'nowrap' }}>{ageText(r.age_days)}</span> },
    { key: 'parked', label: 'Parked at', priority: 3, kind: 'text', text: (r) => r.parked_at ?? '', render: (r) => r.parked_at ?? '—' },
    { key: 'ref', label: 'Ref', priority: 3, kind: 'code', text: (r) => r.ref ?? '', render: (r) => <span className="font-mono text-xs">{r.ref ?? '—'}</span> },
  ];

  return (
    <div style={stackLayout(16)} data-concerns-tab>
      <Card board={board} title="Concerns" ariaLabel="Concerns" busy={q.isFetching} hint={d ? `${scope === 'open' ? 'Open' : 'Open and closed'} · money first` : undefined}>
        {q.isLoading ? (
          <LoadingRows rows={2} height={56} label="Loading the Concerns queue" />
        ) : q.error ? (
          <ErrorLine>The Concerns queue could not load: {readableError(q.error)}</ErrorLine>
        ) : d ? (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 9rem), 1fr))', gap: 16 }}>
            <Figure label="Open" value={d.open_total.toLocaleString('en-US')} />
            <Figure label="Overdue" value={d.overdue_total.toLocaleString('en-US')} tone={d.overdue_total > 0 ? 'bad' : undefined} />
            <Figure label="Logged per day (8 weeks)" value={d.logged_per_day_8wk === null ? '—' : d.logged_per_day_8wk.toLocaleString('en-US', { maximumFractionDigits: 2 })} />
          </div>
        ) : null}
      </Card>

      {/* Filters: source (server), Open / All (server), Overdue only (the loaded rows). */}
      <div style={{ ...stackLayout(8) }}>
        <div role="group" aria-label="Source" style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          <button type="button" aria-pressed={source === null} onClick={() => setSource(null)} className={pill(source === null)} style={PILL_STYLE}>
            All sources
          </button>
          {sources.map((s) => (
            <button
              key={s.source}
              type="button"
              aria-pressed={source === s.source}
              onClick={() => setSource(source === s.source ? null : s.source)}
              className={pill(source === s.source)}
              style={PILL_STYLE}
              data-source={s.source}
            >
              <span>{s.label}</span>
              <span className="tabular-nums font-semibold text-foreground">{s.open.toLocaleString('en-US')}</span>
              {s.overdue > 0 && (
                <span className={`desk-pill border px-1.5 text-xs ${statusGlass.bad}`} style={{ borderWidth: 1, borderStyle: 'solid' }}>
                  {s.overdue} overdue
                </span>
              )}
              {ugxFull(s.money_ugx) && <span className={`${LABEL} tabular-nums`}>{ugxFull(s.money_ugx)}</span>}
            </button>
          ))}
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
          <Segmented<ConcernsScope>
            ariaLabel="Open or all"
            options={[
              { value: 'open', label: 'Open' },
              { value: 'all', label: 'All' },
            ]}
            value={scope}
            onChange={(v) => v && setScope(v)}
          />
          <button type="button" aria-pressed={overdueOnly} onClick={() => setOverdueOnly(!overdueOnly)} className={pill(overdueOnly)} style={PILL_STYLE}>
            Overdue only
          </button>
        </div>
      </div>

      {d && d.by_parked.length > 0 && (
        <Card board={board} title="Where it's parked" ariaLabel="Where it's parked">
          <ul style={{ margin: 0, padding: 0, ...stackLayout(0) }} data-parked>
            {d.by_parked.map((p) => (
              <li key={p.parked_at} className="border-t border-[var(--desk-line-color)] first:border-t-0 text-sm" style={{ listStyle: 'none', display: 'flex', justifyContent: 'space-between', gap: 12, padding: '8px 0' }}>
                <span className="text-foreground">{p.parked_at}</span>
                <span className="tabular-nums text-foreground">
                  {p.open.toLocaleString('en-US')} open
                  {p.overdue > 0 && <span className={`ml-2 ${statusText.bad}`}>{p.overdue} overdue</span>}
                </span>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <DataList<ConcernRow>
        columns={columns}
        rows={rows}
        rowKey={(r) => r.key}
        label="concerns"
        loading={q.isLoading}
        error={q.error ? readableError(q.error) : undefined}
        emptyText={overdueOnly ? 'Nothing overdue.' : scope === 'open' ? 'No open concerns.' : 'No concerns.'}
        limit={50}
        board={board}
        onRowOpen={(r) => open(r)}
        rowAttrs={(r) => ({ 'data-concern': r.key, 'data-overdue': r.overdue ? 'true' : undefined })}
      />
    </div>
  );
}
