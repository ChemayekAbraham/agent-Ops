import { useEffect, useRef, useState, type ReactNode } from 'react';
import { FileText, MapPin, Phone, X } from 'lucide-react';
import { useAuth } from '@/hooks/useAuth';
import { useFundersBoardCanDemote } from '@/hooks/useFundersBoardCanDemote';
import { useSelfSupportFeePolicy } from '@/hooks/useSelfSupportFeePolicy';
import { CALM, FOCUS, LABEL, PANEL, statusGlass, statusText, type Status } from '../deskTheme';
import { Skeleton } from '../Skeleton';
import { KindChip } from '../KindChip';
import { IdentityBanner, IdentityPanel } from '../identityPhotos';
import { DeskHistory, when } from '../deskHistory';
import { missingText } from '../incomplete';
import { STAGE_WORDS, useMoneyFlow, type MoneyFlowItem } from '../moneyFlow';
import { lcLetterUrl, readableError } from '../reviewApi';
import { Chip, DecisionButton, ErrorLine, atLeast, moneyFull, stackLayout, useBreakpoint } from '../ui';
import type { FundersRow } from './cfoApi';
import { UNSOLD_7D_LABEL, heldLabel, isUnsold7d, ugx } from './fundersView';
import { canRecall, funderLine, refText, useFunderPick, usePlanPeople, type BoardFacts } from './planDrawerApi';
import { RecallSheet } from './RecallSheet';

/**
 * The full Rent Plan behind a Funders Dashboard row, read-only: what funders
 * see, who picked it and where the money is, the people with their phones,
 * the house and identity photos, the LC1 letter and every desk's history.
 * The one action is Recall (E86), offered only to staff funders_board_can_demote()
 * allows and only while the money is still with the agent; funded_recall decides.
 */

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0 space-y-1">
      <div className={LABEL}>{label}</div>
      <div className="break-words text-sm text-foreground">{children}</div>
    </div>
  );
}

function PhoneLine({ phone }: { phone: string | null }) {
  if (!phone) return <div className="text-xs text-muted-foreground">no number</div>;
  return (
    <a href={`tel:${phone.replace(/\s+/g, '')}`} className={`flex w-fit items-center gap-1 text-xs text-[hsl(var(--primary))] underline-offset-2 hover:underline ${FOCUS}`}>
      <Phone className="h-3 w-3" aria-hidden />
      {phone}
    </a>
  );
}

function LcLetter({ bucket, path }: { bucket: string | null; path: string }) {
  const [url, setUrl] = useState<string | null>(null);
  const [gone, setGone] = useState(false);
  useEffect(() => {
    let live = true;
    lcLetterUrl(bucket, path).then((u) => {
      if (!live) return;
      if (u) setUrl(u);
      else setGone(true);
    });
    return () => {
      live = false;
    };
  }, [bucket, path]);
  if (gone) return <span className={statusText.bad}>The LC1 letter file could not be opened.</span>;
  if (!url) return <Skeleton className="h-4 w-28" />;
  return (
    <a href={url} target="_blank" rel="noopener noreferrer" className={`inline-flex items-center gap-1.5 rounded text-[hsl(var(--desk-lavender))] underline underline-offset-4 ${FOCUS}`}>
      <FileText className="h-3.5 w-3.5" aria-hidden /> Open the LC1 letter
    </a>
  );
}

function HousePhotos({ urls }: { urls: string[] }) {
  if (!urls.length) return <span className={statusText.bad}>No photos of the house.</span>;
  return (
    <div className="flex flex-wrap gap-2" data-house-photos>
      {urls.map((u, i) => (
        <a key={`${u}-${i}`} href={u} target="_blank" rel="noopener noreferrer" aria-label={`House photo ${i + 1} of ${urls.length}`} className={`block overflow-hidden rounded-lg border border-[var(--desk-line-color)] ${FOCUS}`}>
          <img src={u} alt="" loading="lazy" className="h-20 w-28 object-cover" />
        </a>
      ))}
    </div>
  );
}

function Section({ title, children, ...rest }: { title: string; children: ReactNode } & Record<`data-${string}`, string | boolean | undefined>) {
  return (
    <section className={`${PANEL} space-y-3 p-4`} aria-label={title} {...rest}>
      <h3 className="text-sm font-semibold text-foreground" style={{ margin: 0 }}>
        {title}
      </h3>
      {children}
    </section>
  );
}

/** "Picked by Grace A. · 12 Nov, 09:14", "Held by … since … · until …", or that nobody has. */
function PickLine({ requestId }: { requestId: string }) {
  const q = useFunderPick(requestId);
  if (q.isLoading) return <Skeleton className="h-4 w-56" />;
  if (q.error) return <ErrorLine>{readableError(q.error)}</ErrorLine>;
  const p = q.data;
  if (!p) return <p className="text-sm text-muted-foreground" style={{ margin: 0 }} data-funder-pick="none">No funder has picked this yet.</p>;
  return (
    <p className="text-sm text-foreground" style={{ margin: 0 }} data-funder-pick={p.status}>
      {p.status === 'confirmed' ? 'Picked by ' : 'Held by '}
      <span className="font-medium">{p.who ?? 'a funder'}</span>
      {p.status === 'confirmed' ? ` · ${when(p.at)}` : ` since ${when(p.at)}${p.expiresAt ? ` · until ${when(p.expiresAt)}` : ''}`}
    </p>
  );
}

/** The money stage from funded_money_flow: With agent, Part paid or LIVE, else not released. */
function MoneyStage({ q, item }: { q: ReturnType<typeof useMoneyFlow>; item: MoneyFlowItem | undefined }) {
  if (!item && q.isLoading) return <Skeleton className="h-4 w-48" />;
  if (!item && q.error) return <ErrorLine>{readableError(q.error)}</ErrorLine>;
  if (!item) {
    return (
      <p className="text-sm text-muted-foreground" style={{ margin: 0 }} data-money-stage="none">
        Not released — no funder money has gone to the agent for this plan.
      </p>
    );
  }
  const st = STAGE_WORDS[item.stage] ?? { text: String(item.stage).replace(/_/g, ' '), tone: 'idle' as Status };
  const paid = Number(item.paid_out ?? 0);
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm" data-money-stage={item.stage}>
      <Chip tone={st.tone}>{st.text}</Chip>
      <span className="text-foreground">
        {moneyFull(item.amount)} released to agent {item.agent ?? '—'}
        {paid > 0 ? ` · ${moneyFull(paid)} paid to the landlord` : ''}
      </span>
    </div>
  );
}

export function FundersPlanDrawer({
  row,
  facts,
  onClose,
  release,
}: {
  row: FundersRow;
  facts: BoardFacts | null;
  onClose: () => void;
  /** Opened from a release list: its stage stands in when the 30-day feed does not carry it. */
  release?: MoneyFlowItem | null;
}) {
  const phone = !atLeast(useBreakpoint(), 'md');
  const close = useRef<HTMLButtonElement>(null);
  const { pay } = useSelfSupportFeePolicy();
  const people = usePlanPeople(row.id);
  const p = people.data;
  const { user } = useAuth();
  const canDemote = useFundersBoardCanDemote(user?.id);
  const flow = useMoneyFlow();
  const moneyItem = flow.data?.items.find((i) => i.rent_request_id === row.id) ?? release ?? undefined;
  const pick = useFunderPick(row.id);
  const [recallOpen, setRecallOpen] = useState(false);
  const recallable = canRecall(canDemote, moneyItem?.stage);
  const missing = missingText(facts?.incomplete);
  const held = heldLabel(row);
  const photos = p?.photos.length ? p.photos : (Array.isArray(row.photos) ? row.photos.filter((u): u is string => typeof u === 'string' && !!u) : []);
  const gps = row.gps;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    close.current?.focus();
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex justify-end" role="dialog" aria-modal="true" aria-label={`Rent Plan ${refText(row.id)}`} data-plan-drawer={row.id}>
      <button type="button" aria-label="Close the plan" tabIndex={-1} onClick={onClose} className="absolute inset-0 bg-black/60" />
      <div
        data-drawer={phone ? 'sheet' : 'side'}
        className={`desk-root relative flex h-full w-full flex-col overflow-hidden shadow-2xl ${phone ? '' : 'max-w-3xl border-l border-[var(--desk-line-color)]'}`}
      >
        <header className="flex shrink-0 items-start justify-between gap-4 border-b border-[var(--desk-line-color)] px-5 py-4">
          <div className="min-w-0 space-y-1.5">
            <h2 className="text-lg font-semibold text-foreground" style={{ margin: 0, overflowWrap: 'anywhere' }}>
              {row.tenant ?? p?.tenant.name ?? 'Rent Plan'}
            </h2>
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-mono text-xs text-muted-foreground" data-plan-ref>
                {refText(row.id)}
              </span>
              {facts?.requestKind && <KindChip kind={{ code: facts.requestKind, label: null, color: null, detail: null }} />}
              {isUnsold7d(row) && <Chip tone="idle" size="xs">{UNSOLD_7D_LABEL}</Chip>}
              {held && <Chip tone="warn" size="xs">{held}</Chip>}
            </div>
          </div>
          <button
            ref={close}
            type="button"
            onClick={onClose}
            aria-label="Close"
            className={`desk-pill border border-[var(--desk-line-color)] bg-[var(--desk-surface)] p-2 ${CALM} ${FOCUS} hover:bg-[var(--desk-surface-hover)]`}
          >
            <X className="h-4 w-4" aria-hidden />
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-auto px-5 py-5" style={stackLayout(20)}>
          {missing && (
            <p role="alert" data-plan-missing className={`rounded-xl border px-3 py-2 text-sm font-medium ${statusGlass.warn}`} style={{ margin: 0 }}>
              {missing}
            </p>
          )}
          <IdentityBanner requestId={row.id} />

          <Section title="Funding" data-plan-funding>
            <div className="grid gap-4 sm:grid-cols-2">
              <Fact label="Rent">
                <span className="text-xl font-semibold tabular-nums">{ugx(row.rent)}</span>
                {p?.durationDays ? <span className="ml-2 text-xs text-muted-foreground">over {p.durationDays} days</span> : null}
              </Fact>
              <Fact label="What funders see">
                {facts ? <span data-funder-line>{funderLine(facts, pay)}</span> : <span className="text-muted-foreground">Not on the funders&rsquo; board list.</span>}
              </Fact>
              <Fact label="Funder pick">
                <PickLine requestId={row.id} />
              </Fact>
              <Fact label="Money">
                <MoneyStage q={flow} item={moneyItem} />
                {recallable && (
                  <DecisionButton size="sm" variant="danger" className="mt-2" onClick={() => setRecallOpen(true)} data-recall-open>
                    Recall
                  </DecisionButton>
                )}
              </Fact>
            </div>
          </Section>

          <Section title="People" data-plan-people>
            {people.isLoading ? (
              <div className="grid gap-4 sm:grid-cols-2" role="status" aria-label="Loading the people">
                <Skeleton className="h-10 w-full" />
                <Skeleton className="h-10 w-full" />
              </div>
            ) : (
              <>
                {people.error && <ErrorLine>{readableError(people.error)}</ErrorLine>}
                <div className="grid gap-4 sm:grid-cols-2">
                  <Fact label="Tenant">
                    {p?.tenant.name ?? row.tenant ?? '—'}
                    {p && <PhoneLine phone={p.tenant.phone} />}
                    {row.tenant_location && <div className="text-xs text-muted-foreground">{row.tenant_location}</div>}
                  </Fact>
                  <Fact label="Agent">
                    {p?.agent.name ?? row.agent ?? '—'}
                    {p && <PhoneLine phone={p.agent.phone} />}
                  </Fact>
                  <Fact label="Landlord">
                    {p?.landlord.name ?? row.landlord ?? '—'}
                    <PhoneLine phone={p?.landlord.phone ?? row.landlord_phone} />
                    {p?.landlord.verified !== null && p?.landlord.verified !== undefined && (
                      <span className={`desk-pill mt-1 inline-block border px-2 py-0.5 text-xs ${p.landlord.verified ? statusGlass.ok : statusGlass.warn}`}>
                        {p.landlord.verified ? 'Verified' : 'Not verified'}
                      </span>
                    )}
                  </Fact>
                  <Fact label="LC1">
                    {p?.lc1 ?? row.lc1 ?? 'No chairperson recorded'}
                    <div className="mt-1" data-lc1-letter>
                      {p?.lcLetter ? (
                        <LcLetter bucket={p.lcLetter.bucket} path={p.lcLetter.path} />
                      ) : p ? (
                        <span className={statusText.warn}>No LC1 letter on file.</span>
                      ) : null}
                    </div>
                  </Fact>
                </div>
              </>
            )}
          </Section>

          <Section title="The house" data-plan-house>
            <HousePhotos urls={photos} />
            {gps && (
              <a
                href={`https://www.google.com/maps/search/?api=1&query=${gps.lat},${gps.lng}`}
                target="_blank"
                rel="noopener noreferrer"
                className={`inline-flex items-center gap-1.5 rounded text-sm text-[hsl(var(--desk-lavender))] underline underline-offset-4 ${FOCUS}`}
              >
                <MapPin className="h-3.5 w-3.5" aria-hidden /> Open the pin on the map
              </a>
            )}
          </Section>

          <IdentityPanel requestId={row.id} />

          <section aria-label="Desk history" data-plan-history style={stackLayout(8)}>
            <h3 className="text-sm font-semibold text-foreground" style={{ margin: 0 }}>
              Desk history
            </h3>
            <DeskHistory requestId={row.id} />
          </section>
        </div>
      </div>
      {recallOpen && recallable && moneyItem && (
        <RecallSheet
          requestId={row.id}
          amount={moneyItem.amount}
          agent={moneyItem.agent ?? p?.agent.name ?? row.agent}
          funder={pick.data?.who ?? null}
          onClose={() => setRecallOpen(false)}
        />
      )}
    </div>
  );
}
