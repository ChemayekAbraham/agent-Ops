import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronLeft, Paperclip, Star, Inbox, Clock, Archive, Trash2, MailOpen, Loader2, Wallet, History } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { supabase } from '@/integrations/supabase/client';
import { UserSearchPicker, type UserResult } from '@/components/cfo/UserSearchPicker';

/**
 * Minimal shape needed to render an extracted transaction email in a
 * Gmail-like inbox row. Mirrors the `gmail_transactions` columns the
 * Email Transaction Extractor already loads.
 */
export interface GmailStyleRow {
  id: string;
  from_email?: string | null;
  from_name?: string | null;
  subject?: string | null;
  snippet?: string | null;
  amount?: number | null;
  transaction_id?: string | null;
  internal_date?: string | null;
  direction?: string | null;
  channel?: string | null;
  counterparty?: string | null;
  fee?: number | null;
  balance?: number | null;
}

// Muted tonal avatars keep the inbox calm and professional instead of
// scattering saturated blocks of colour down the list.
const AVATAR_TONES = [
  'bg-rose-500/12 text-rose-600', 'bg-amber-500/12 text-amber-600',
  'bg-emerald-500/12 text-emerald-600', 'bg-sky-500/12 text-sky-600',
  'bg-indigo-500/12 text-indigo-600', 'bg-violet-500/12 text-violet-600',
  'bg-teal-500/12 text-teal-600', 'bg-orange-500/12 text-orange-600',
];

function toneFor(seed: string) {
  let h = 0;
  for (let i = 0; i < seed.length; i += 1) h = (h * 31 + seed.charCodeAt(i)) % 997;
  return AVATAR_TONES[h % AVATAR_TONES.length];
}

function senderName(r: GmailStyleRow) {
  return (r.from_name || r.from_email || 'Unknown sender').trim();
}

/**
 * The person the money actually came from — NOT the mail gateway. SMS-relayed
 * MoMo alerts always arrive from the same forwarder ("Android SMS via IFTTT"),
 * so the counterparty (or the "from NAME at" fragment in the body) is what
 * identifies the payer across emails.
 */
function payerName(r: GmailStyleRow): string | null {
  const cp = (r.counterparty || '').trim();
  if (cp) return cp;
  const body = `${r.snippet || ''} ${r.subject || ''}`;
  const m = body.match(/from\s+([A-Za-z][A-Za-z .'-]{2,60}?)\s+(?:at|on|\d)/i);
  return m ? m[1].trim() : null;
}

/** Stable, case-insensitive memory key for a payer name. */
function senderKeyFor(r: GmailStyleRow): string | null {
  const name = payerName(r);
  if (!name) return null;
  const key = name.replace(/\s+/g, ' ').trim().toUpperCase();
  return key.length >= 3 ? key : null;
}

interface SenderBinding {
  user_id: string;
  user_name: string | null;
  user_phone: string | null;
  times_used: number;
  last_routed_at: string | null;
}

/** Gmail-style date column: time for today, "MMM d" otherwise. */
function gmailDate(iso?: string | null) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  return sameDay
    ? d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
    : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function fmtUgx(n?: number | null) {
  if (n == null || !Number.isFinite(n)) return null;
  return `UGX ${Math.round(n).toLocaleString('en-US')}`;
}

/** Gmail groups its inbox under date rollups: Today, Yesterday, then dates. */
function dateGroupLabel(iso?: string | null) {
  if (!iso) return 'No date';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 'No date';
  const now = new Date();
  const dayKey = (x: Date) => `${x.getFullYear()}-${x.getMonth()}-${x.getDate()}`;
  const yesterday = new Date(now.getTime() - 86_400_000);
  if (dayKey(d) === dayKey(now)) return 'Today';
  if (dayKey(d) === dayKey(yesterday)) return 'Yesterday';
  const sameYear = d.getFullYear() === now.getFullYear();
  return d.toLocaleDateString(undefined, sameYear
    ? { weekday: 'short', month: 'short', day: 'numeric' }
    : { month: 'short', day: 'numeric', year: 'numeric' });
}

const BATCH = 40;

/**
 * Renders the extracted money-in / money-out emails exactly the way Gmail
 * shows an inbox: avatar, bold sender, subject followed by a muted snippet on
 * one line, and a right-aligned date. Tapping a row opens a Gmail-style
 * reading pane with the full header block and body text.
 *
 * Purely presentational — routing/charging actions stay in the detailed ops
 * view, reachable via the "Ops view" switch in the parent header.
 */
interface GmailStyleEmailListProps {
  rows: GmailStyleRow[];
  onCreditUser?: (row: GmailStyleRow, user: UserResult) => void;
}

export function GmailStyleEmailList({ rows, onCreditUser }: GmailStyleEmailListProps) {
  const [openId, setOpenId] = useState<string | null>(null);
  const [selectedUsers, setSelectedUsers] = useState<Record<string, UserResult>>({});
  // Remembered payer → wallet bindings, keyed by the normalised payer name.
  const [bindings, setBindings] = useState<Record<string, SenderBinding | null>>({});
  const [showManual, setShowManual] = useState(false);
  // Always present the newest email first, even if the parent list order drifts
  // (e.g. realtime inserts, focus-direction resets, or cached presets).
  const sortedRows = useMemo(
    () =>
      [...rows].sort((a, b) => {
        const ta = a.internal_date ? new Date(a.internal_date).getTime() : 0;
        const tb = b.internal_date ? new Date(b.internal_date).getTime() : 0;
        return tb - ta;
      }),
    [rows],
  );
  const open = openId ? sortedRows.find((r) => r.id === openId) ?? null : null;

  // ── Gmail-style endless scroll: render a first batch and grow it as the
  // sentinel at the bottom of the list scrolls into view. Date rollups
  // ("Today", "Yesterday", "Mon, Aug 4") separate the batches visually.
  const [count, setCount] = useState(BATCH);
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => { setCount(BATCH); }, [rows.length]);
  const shown = sortedRows.slice(0, count);
  const hasMore = count < sortedRows.length;
  useEffect(() => {
    if (open || !hasMore) return;
    const el = sentinelRef.current;
    if (!el || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) {
        setCount((c) => Math.min(c + BATCH, sortedRows.length));
      }
    }, { rootMargin: '600px 0px' });
    io.observe(el);
    return () => io.disconnect();
  }, [open, hasMore, sortedRows.length]);

  // When an inbound email is opened, look up whether this payer name was
  // routed to a wallet before so the operator is prompted with the same
  // recipient instead of searching for them again.
  const openKey = open ? senderKeyFor(open) : null;
  useEffect(() => {
    setShowManual(false);
    if (!openKey || openKey in bindings) return;
    let cancelled = false;
    (async () => {
      const { data } = await supabase
        .from('email_sender_wallet_bindings')
        .select('user_id, user_name, user_phone, times_used, last_routed_at')
        .eq('sender_key', openKey)
        .maybeSingle();
      if (!cancelled) {
        setBindings((c) => ({ ...c, [openKey]: (data as SenderBinding | null) ?? null }));
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openKey]);

  /** Route + remember, so the next email from this payer prompts the same wallet. */
  const routeToWallet = async (row: GmailStyleRow, user: UserResult) => {
    const key = senderKeyFor(row);
    if (key) {
      setBindings((c) => ({
        ...c,
        [key]: {
          user_id: user.id,
          user_name: user.full_name,
          user_phone: user.phone,
          times_used: (c[key]?.user_id === user.id ? (c[key]?.times_used ?? 0) : 0) + 1,
          last_routed_at: new Date().toISOString(),
        },
      }));
      try {
        await supabase.rpc('remember_email_sender_wallet', {
          p_sender_key: key,
          p_sender_label: payerName(row),
          p_user_id: user.id,
          p_user_name: user.full_name,
          p_user_phone: user.phone,
        });
      } catch {
        // Memory is a convenience — never block the actual routing action.
      }
    }
    onCreditUser?.(row, user);
  };

  if (open) {
    const name = senderName(open);
    const amount = fmtUgx(open.amount);
    return (
      <div className="bg-background">
        <div className="flex items-center gap-1 px-2 py-1.5 border-b">
          <Button
            size="icon"
            variant="ghost"
            className="h-9 w-9 rounded-full"
            aria-label="Back to inbox"
            title="Back to inbox"
            onClick={() => setOpenId(null)}
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <span className="mx-1 h-5 w-px bg-border" aria-hidden />
          {[
            { Icon: Archive, label: 'Archive' },
            { Icon: Trash2, label: 'Delete' },
            { Icon: MailOpen, label: 'Mark as unread' },
            { Icon: Clock, label: 'Snooze' },
          ].map(({ Icon, label }) => (
            <span
              key={label}
              title={`${label} — read-only view`}
              aria-hidden
              className="hidden sm:flex h-9 w-9 items-center justify-center rounded-full text-muted-foreground/40"
            >
              <Icon className="h-4 w-4" />
            </span>
          ))}
        </div>
        <div className="px-4 sm:px-6 py-4">
          <h3 className="text-base sm:text-lg font-medium leading-snug break-words tracking-tight">
            {open.subject || '(no subject)'}
          </h3>
          <div className="mt-4 flex items-start gap-3">
            <span
              className={`h-9 w-9 shrink-0 rounded-full flex items-center justify-center text-sm font-semibold ${toneFor(name)}`}
              aria-hidden
            >
              {name.charAt(0).toUpperCase()}
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-baseline gap-x-2">
                <span className="text-sm font-semibold">{name}</span>
                {open.from_email && (
                  <span className="text-xs text-muted-foreground break-all">
                    &lt;{open.from_email}&gt;
                  </span>
                )}
              </div>
              <p className="text-xs text-muted-foreground mt-0.5">
                to me
                {open.internal_date
                  ? ` · ${new Date(open.internal_date).toLocaleString()}`
                  : ''}
              </p>
            </div>
          </div>
          <div className="mt-4 text-sm leading-relaxed whitespace-pre-wrap break-words">
            {open.snippet || 'No message body was captured for this email.'}
          </div>
          {open.direction === 'in' && onCreditUser && (
            <div className="mt-5 border-y bg-muted/20 py-4">
              {openKey && bindings[openKey] && !showManual ? (
                <div className="space-y-3">
                  <div className="rounded-lg border border-primary/30 bg-primary/5 p-3">
                    <p className="text-xs font-semibold uppercase tracking-wide text-primary flex items-center gap-1.5">
                      <History className="h-3.5 w-3.5" /> Previously routed payer
                    </p>
                    <p className="mt-1.5 text-sm">
                      Payments from <span className="font-semibold">{payerName(open)}</span> were routed to{' '}
                      <span className="font-semibold">{bindings[openKey]!.user_name || 'this wallet'}</span>
                      {bindings[openKey]!.user_phone ? ` (${bindings[openKey]!.user_phone})` : ''}.
                    </p>
                    <p className="mt-0.5 text-[11px] text-muted-foreground">
                      Used {bindings[openKey]!.times_used}×
                      {bindings[openKey]!.last_routed_at
                        ? ` · last on ${new Date(bindings[openKey]!.last_routed_at as string).toLocaleDateString()}`
                        : ''}
                    </p>
                  </div>
                  <div className="flex flex-col gap-2 sm:flex-row">
                    <Button
                      className="h-10 gap-2 sm:min-w-56"
                      onClick={() => {
                        const b = bindings[openKey]!;
                        routeToWallet(open, {
                          id: b.user_id,
                          full_name: b.user_name || 'Saved recipient',
                          phone: b.user_phone || '',
                        });
                      }}
                    >
                      <Wallet className="h-4 w-4" />
                      Route to {bindings[openKey]!.user_name || 'saved wallet'}
                    </Button>
                    <Button variant="outline" className="h-10" onClick={() => setShowManual(true)}>
                      Route to a different user
                    </Button>
                  </div>
                </div>
              ) : (
              <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
                <div className="min-w-0 flex-1">
                  <UserSearchPicker
                    label="Search user by phone number or name"
                    placeholder="Enter phone number or user name…"
                    selectedUser={selectedUsers[open.id] ?? null}
                    onSelect={(user) => {
                      setSelectedUsers((current) => {
                        const next = { ...current };
                        if (user) next[open.id] = user;
                        else delete next[open.id];
                        return next;
                      });
                    }}
                  />
                </div>
                <Button
                  className="h-10 shrink-0 gap-2 sm:min-w-40"
                  disabled={!selectedUsers[open.id]}
                  onClick={() => {
                    const user = selectedUsers[open.id];
                    if (user) routeToWallet(open, user);
                  }}
                >
                  <Wallet className="h-4 w-4" />
                  Route to wallet
                </Button>
              </div>
              )}
            </div>
          )}
          <div className="mt-5 flex flex-wrap gap-1.5 text-[11px] text-muted-foreground">
            {amount && (
              <span className="rounded-full border bg-muted/40 px-2.5 py-1 font-mono tabular-nums text-foreground">
                {amount}
              </span>
            )}
            {open.transaction_id && (
              <span className="rounded-full border bg-muted/40 px-2.5 py-1 font-mono">
                Ref {open.transaction_id}
              </span>
            )}
            {open.channel && (
              <span className="rounded-full border bg-muted/40 px-2.5 py-1 capitalize">{open.channel}</span>
            )}
            {open.counterparty && (
              <span className="rounded-full border bg-muted/40 px-2.5 py-1">{open.counterparty}</span>
            )}
            {fmtUgx(open.fee) && (
              <span className="rounded-full border bg-muted/40 px-2.5 py-1 font-mono tabular-nums">
                Fee {fmtUgx(open.fee)}
              </span>
            )}
            {fmtUgx(open.balance) && (
              <span className="rounded-full border bg-muted/40 px-2.5 py-1 font-mono tabular-nums">
                Balance {fmtUgx(open.balance)}
              </span>
            )}
          </div>
        </div>
      </div>
    );
  }

  if (sortedRows.length === 0) {
    return (
      <div className="px-6 py-16 text-center">
        <Inbox className="mx-auto h-10 w-10 text-muted-foreground/30" aria-hidden />
        <p className="mt-3 text-sm font-medium">Nothing in this view</p>
        <p className="mt-1 text-xs text-muted-foreground">
          Try another label on the left, or widen the date window.
        </p>
      </div>
    );
  }

  let lastGroup: string | null = null;

  return (
    <>
    <ul className="divide-y divide-border/50">
      {shown.map((r, i) => {
        const name = senderName(r);
        const amount = fmtUgx(r.amount);
        // Gmail visually bolds "unread" mail. Here the freshest arrivals read as
        // unread so the operator's eye lands on new traffic first.
        const unread = i < 3;
        const group = dateGroupLabel(r.internal_date);
        const showGroup = group !== lastGroup;
        lastGroup = group;
        return (
          <Fragment key={r.id}>
          {showGroup && (
            <li
              className="sticky top-0 z-[5] bg-muted/60 backdrop-blur px-3 sm:px-4 py-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground"
            >
              {group}
            </li>
          )}
          <li key={r.id} className="relative">
            <button
              type="button"
              onClick={() => setOpenId(r.id)}
              className={`group relative w-full text-left flex items-center gap-3 px-3 sm:px-4 py-2 sm:py-[9px] transition-shadow hover:z-10 hover:shadow-[0_1px_2px_0_hsl(var(--foreground)/0.14),0_1px_3px_1px_hsl(var(--foreground)/0.08)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                unread ? 'bg-background' : 'bg-muted/25'
              }`}
            >
              <span
                className="hidden sm:flex h-4 w-4 shrink-0 items-center justify-center rounded-[3px] border border-muted-foreground/40"
                aria-hidden
              />
              <Star
                className="hidden sm:block h-4 w-4 shrink-0 text-muted-foreground/30 hover:text-amber-500"
                aria-hidden
              />
              <span
                className={`h-7 w-7 shrink-0 rounded-full flex items-center justify-center text-[11px] font-semibold ${toneFor(name)}`}
                aria-hidden
              >
                {name.charAt(0).toUpperCase()}
              </span>
              <span className={`w-28 sm:w-44 shrink-0 truncate text-[13px] ${unread ? 'font-bold text-foreground' : 'font-normal text-foreground/80'}`}>
                {name}
              </span>
              <span className="min-w-0 flex-1 truncate text-[13px]">
                <span className={unread ? 'font-bold text-foreground' : 'text-foreground/80'}>
                  {r.subject || '(no subject)'}
                </span>
                {r.snippet && (
                  <span className="text-muted-foreground/80"> &ndash; {r.snippet}</span>
                )}
              </span>
              {amount && (
                <span className={`hidden md:inline shrink-0 text-[11px] font-mono tabular-nums ${unread ? 'text-foreground' : 'text-muted-foreground'}`}>
                  {amount}
                </span>
              )}
              {r.transaction_id && (
                <Paperclip className="hidden lg:block h-3.5 w-3.5 shrink-0 text-muted-foreground/60" aria-hidden />
              )}
              {/* Gmail swaps the date column for row actions on hover. */}
              <span className="shrink-0 w-16 text-right">
                <span className={`text-[11px] tabular-nums group-hover:hidden ${unread ? 'font-bold text-foreground' : 'font-medium text-muted-foreground'}`}>
                {gmailDate(r.internal_date)}
                </span>
                <span className="hidden group-hover:inline-flex items-center justify-end gap-1 text-muted-foreground" aria-hidden>
                  <Archive className="h-3.5 w-3.5 hover:text-foreground" />
                  <Clock className="h-3.5 w-3.5 hover:text-foreground" />
                  <MailOpen className="h-3.5 w-3.5 hover:text-foreground" />
                </span>
              </span>
            </button>
          </li>
          </Fragment>
        );
      })}
    </ul>
    {hasMore && (
      <div ref={sentinelRef} className="flex items-center justify-center gap-2 py-5 text-xs text-muted-foreground">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        Loading more conversations… ({(sortedRows.length - count).toLocaleString()} left)
      </div>
    )}
    </>
  );
}
