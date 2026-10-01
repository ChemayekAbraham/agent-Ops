import { useState } from 'react';
import {
  AlertCircle,
  ArrowLeft,
  BadgeDollarSign,
  BriefcaseBusiness,
  Building2,
  CalendarDays,
  Eye,
  EyeOff,
  Fingerprint,
  HandCoins,
  Landmark,
  Loader2,
  MapPin,
  Phone,
  ReceiptText,
  ShieldCheck,
  ShoppingBag,
  TrendingUp,
  UserRound,
  WalletCards,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Skeleton } from '@/components/ui/skeleton';
import { AiIdBadge } from '@/components/ai-id/AiIdBadge';
import { formatUGX } from '@/lib/rentCalculations';
import { cn } from '@/lib/utils';
import { maskMoney, maskSensitiveValue } from '@/lib/shoppingAdvanceDossier';
import { DossierRecord, useShoppingAdvanceUserDossier } from '@/hooks/useShoppingAdvanceUserDossier';

type Props = { userId: string; fallbackName: string; onBack: () => void };

const text = (value: unknown, fallback = '—') => value == null || value === '' ? fallback : String(value);
const number = (value: unknown) => Number(value ?? 0);
const rows = (value: unknown): DossierRecord[] => Array.isArray(value) ? value as DossierRecord[] : [];
const date = (value: unknown) => value ? new Date(String(value)).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : '—';
const label = (key: string) => key.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()).replace(/Roi/gi, 'Returns');
const initials = (name: string) => name.split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0]).join('').toUpperCase() || 'WU';

function Amount({ value, revealed }: { value: unknown; revealed: boolean }) {
  return <>{maskMoney(revealed, formatUGX(number(value)))}</>;
}

function Metric({ icon: Icon, title, value, hint, tone = 'primary' }: {
  icon: typeof WalletCards; title: string; value: React.ReactNode; hint?: string; tone?: 'primary' | 'success' | 'warning' | 'destructive';
}) {
  const tones = {
    primary: 'bg-primary/10 text-primary', success: 'bg-success/10 text-success',
    warning: 'bg-warning/10 text-warning', destructive: 'bg-destructive/10 text-destructive',
  };
  return (
    <div className="min-w-0 rounded-lg border border-border bg-card p-4">
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs font-semibold uppercase text-muted-foreground">{title}</p>
        <span className={cn('rounded-md p-2', tones[tone])}><Icon className="h-4 w-4" aria-hidden /></span>
      </div>
      <p className="mt-3 break-words text-xl font-bold text-foreground">{value}</p>
      {hint && <p className="mt-1 text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

function Empty({ children }: { children: string }) {
  return <div className="py-12 text-center text-sm text-muted-foreground">{children}</div>;
}

function RecordList({ items, empty, revealed, render }: {
  items: DossierRecord[]; empty: string; revealed: boolean;
  render: (item: DossierRecord, revealed: boolean) => React.ReactNode;
}) {
  if (!items.length) return <Empty>{empty}</Empty>;
  return <div className="grid gap-3 lg:grid-cols-2">{items.map((item, i) => (
    <div key={text(item.id, String(i))} className="rounded-lg border border-border bg-card p-4">{render(item, revealed)}</div>
  ))}</div>;
}

function KeyValues({ data, revealed }: { data: DossierRecord | null; revealed: boolean }) {
  if (!data || !Object.keys(data).length) return <Empty>AI ID details are unavailable for this user.</Empty>;
  const hidden = /amount|balance|income|outflow|inflow|limit|paid|owing|rent|wallet/i;
  return <dl className="grid gap-px overflow-hidden rounded-lg border border-border bg-border sm:grid-cols-2 lg:grid-cols-3">
    {Object.entries(data).map(([key, value]) => {
      const display = typeof value === 'object' && value !== null
        ? JSON.stringify(value)
        : hidden.test(key) && typeof value === 'number'
          ? maskMoney(revealed, formatUGX(value))
          : typeof value === 'boolean' ? (value ? 'Yes' : 'No') : text(value);
      return <div key={key} className="min-w-0 bg-background p-3">
        <dt className="text-xs text-muted-foreground">{label(key)}</dt>
        <dd className="mt-1 break-words text-sm font-semibold">{display}</dd>
      </div>;
    })}
  </dl>;
}

export function ShoppingAdvanceUserDossier({ userId, fallbackName, onBack }: Props) {
  const [revealed, setRevealed] = useState(false);
  const { data, isLoading, error, refetch } = useShoppingAdvanceUserDossier(userId);

  if (isLoading) return <div className="space-y-5 py-4">
    <Skeleton className="h-24 w-full" /><div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">{[0,1,2,3].map(i => <Skeleton key={i} className="h-28" />)}</div><Skeleton className="h-72 w-full" />
  </div>;

  if (error || !data) return <div className="space-y-4 py-4">
    <Button variant="ghost" size="sm" onClick={onBack}><ArrowLeft className="mr-1 h-4 w-4" />Back to users</Button>
    <Alert variant="destructive"><AlertCircle className="h-4 w-4" /><AlertTitle>Dossier unavailable</AlertTitle><AlertDescription>This user's details could not be loaded. Your access may have changed, or the record is unavailable.</AlertDescription></Alert>
    <Button variant="outline" onClick={() => refetch()}>Try again</Button>
  </div>;

  const profile = data.profile ?? {};
  const qualification = data.qualification ?? {};
  const wallet = data.wallet ?? {};
  const rentPlans = rows(data.rent_plans);
  const agentAdvances = rows(data.agent_advances);
  const advanceRequests = rows(data.advance_requests);
  const businessAdvances = rows(data.business_advances);
  const obligations = rows(data.obligations);
  const portfolios = rows(data.portfolios);
  const shares = rows(data.shares);
  const name = text(profile.full_name, fallbackName);
  const roles = rows(profile.roles).length ? rows(profile.roles).map(String) : Array.isArray(profile.roles) ? profile.roles.map(String) : [];
  const totalRentOutstanding = rentPlans.reduce((sum, r) => sum + number(r.outstanding), 0);
  const totalAdvanceOutstanding = agentAdvances.reduce((sum, r) => sum + number(r.outstanding_balance), 0)
    + businessAdvances.reduce((sum, r) => sum + number(r.outstanding_balance), 0)
    + obligations.reduce((sum, r) => sum + number(r.outstanding), 0);

  return <div className="space-y-5 pb-8 pt-3">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <Button variant="ghost" size="sm" onClick={onBack}><ArrowLeft className="mr-1 h-4 w-4" />Qualified users</Button>
      <Button variant="outline" size="sm" onClick={() => setRevealed(v => !v)} aria-pressed={revealed}>
        {revealed ? <EyeOff className="mr-2 h-4 w-4" /> : <Eye className="mr-2 h-4 w-4" />}{revealed ? 'Hide sensitive values' : 'Reveal sensitive values'}
      </Button>
    </div>

    <section className="flex flex-col gap-4 border-b border-border pb-5 sm:flex-row sm:items-center">
      <div className="flex h-16 w-16 shrink-0 items-center justify-center rounded-full bg-primary/10 text-lg font-bold text-primary">{initials(name)}</div>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2"><h2 className="text-xl font-bold">{name}</h2>
          {Boolean(profile.verified) && <Badge variant="success"><ShieldCheck className="mr-1 h-3 w-3" />Verified</Badge>}
          {Boolean(profile.is_frozen) && <Badge variant="destructive">Frozen</Badge>}
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-2 text-sm text-muted-foreground">
          <AiIdBadge aiId={data.ai_id} variant="chip" size="sm" staticMode />
          <span className="inline-flex items-center gap-1"><Phone className="h-3.5 w-3.5" />{revealed ? text(profile.phone) : maskSensitiveValue(text(profile.phone, ''))}</span>
          <span className="inline-flex items-center gap-1"><MapPin className="h-3.5 w-3.5" />{text(profile.location, 'Location not recorded')}</span>
        </div>
        <div className="mt-2 flex flex-wrap gap-1.5">{roles.map(role => <Badge key={role} variant="outline">{label(role)}</Badge>)}</div>
      </div>
    </section>

    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
      <Metric icon={ShoppingBag} title="Shopping access" value={<Amount value={qualification.access_limit} revealed={revealed} />} hint="Informational · not issued funds" />
      <Metric icon={WalletCards} title="Withdrawable" value={Boolean(wallet.available) ? <Amount value={wallet.withdrawable} revealed={revealed} /> : 'Unavailable'} hint={Boolean(wallet.available) ? 'Strict available balance' : 'No wallet projection'} tone="success" />
      <Metric icon={ReceiptText} title="Rent Plan outstanding" value={<Amount value={totalRentOutstanding} revealed={revealed} />} hint={`${rentPlans.length} Rent Plan${rentPlans.length === 1 ? '' : 's'}`} tone="warning" />
      <Metric icon={HandCoins} title="Other obligations" value={<Amount value={totalAdvanceOutstanding} revealed={revealed} />} hint={`${agentAdvances.length + businessAdvances.length + obligations.length} active or historical records`} tone={totalAdvanceOutstanding > 0 ? 'destructive' : 'success'} />
    </div>

    <Tabs defaultValue="overview">
      <div className="overflow-x-auto"><TabsList variant="underline" className="min-w-max justify-start">
        <TabsTrigger variant="underline" value="overview">Overview</TabsTrigger>
        <TabsTrigger variant="underline" value="rent">Rent Plans</TabsTrigger>
        <TabsTrigger variant="underline" value="advances">Advances & obligations</TabsTrigger>
        <TabsTrigger variant="underline" value="partnerships">Partnerships & shares</TabsTrigger>
        <TabsTrigger variant="underline" value="ai">AI ID</TabsTrigger>
      </TabsList></div>

      <TabsContent value="overview" className="space-y-5">
        <div className="grid gap-4 lg:grid-cols-2">
          <section><h3 className="mb-3 flex items-center gap-2 font-semibold"><UserRound className="h-4 w-4 text-primary" />Identity</h3>
            <dl className="grid gap-px overflow-hidden rounded-lg border border-border bg-border sm:grid-cols-2">
              {[
                ['Phone', revealed ? text(profile.phone) : maskSensitiveValue(text(profile.phone, ''))],
                ['Email', revealed ? text(profile.email) : maskSensitiveValue(text(profile.email, ''))],
                ['National ID', revealed ? text(profile.national_id) : maskSensitiveValue(text(profile.national_id, ''))],
                ['Occupation', text(profile.occupation)], ['Joined', date(profile.created_at)], ['Last active', date(profile.last_active_at)],
              ].map(([k,v]) => <div key={k} className="bg-background p-3"><dt className="text-xs text-muted-foreground">{k}</dt><dd className="mt-1 break-words text-sm font-semibold">{v}</dd></div>)}
            </dl>
          </section>
          <section><h3 className="mb-3 flex items-center gap-2 font-semibold"><TrendingUp className="h-4 w-4 text-primary" />Qualification evidence</h3>
            <dl className="grid gap-px overflow-hidden rounded-lg border border-border bg-border sm:grid-cols-2">
              {[['Transfers sent', text(qualification.transfer_count, '0')], ['Total sent', maskMoney(revealed, formatUGX(number(qualification.transfer_total)))], ['First transfer', date(qualification.first_transfer_at)], ['Last transfer', date(qualification.last_transfer_at)]].map(([k,v]) => <div key={k} className="bg-background p-3"><dt className="text-xs text-muted-foreground">{k}</dt><dd className="mt-1 text-sm font-semibold">{v}</dd></div>)}
            </dl>
          </section>
        </div>
        <Alert><ShieldCheck className="h-4 w-4" /><AlertTitle>Read-only dossier</AlertTitle><AlertDescription>The Shopping Advance figure is informational. Viewing this page does not issue funds, move money, or change any account.</AlertDescription></Alert>
      </TabsContent>

      <TabsContent value="rent"><RecordList items={rentPlans} empty="No Rent Plans recorded for this user." revealed={revealed} render={(r, show) => <>
        <div className="flex items-center justify-between gap-3"><span className="font-semibold">Rent Plan</span><Badge variant="outline">{label(text(r.status))}</Badge></div>
        <div className="mt-4 grid grid-cols-2 gap-3 text-sm"><div><p className="text-xs text-muted-foreground">Outstanding</p><p className="font-bold"><Amount value={r.outstanding} revealed={show} /></p></div><div><p className="text-xs text-muted-foreground">Paid</p><p className="font-semibold"><Amount value={r.amount_repaid} revealed={show} /></p></div><div><p className="text-xs text-muted-foreground">Daily amount</p><p className="font-semibold"><Amount value={r.daily_repayment} revealed={show} /></p></div><div><p className="text-xs text-muted-foreground">Agent</p><p className="font-semibold">{text(r.agent_name)}</p></div></div>
        <p className="mt-3 text-xs text-muted-foreground"><CalendarDays className="mr-1 inline h-3 w-3" />Created {date(r.created_at)} · Funded {date(r.funded_at)}</p>
      </>} /></TabsContent>

      <TabsContent value="advances" className="space-y-6">
        <section><h3 className="mb-3 flex items-center gap-2 font-semibold"><BadgeDollarSign className="h-4 w-4 text-primary" />Agent Advances</h3><RecordList items={agentAdvances} empty="No Agent Advances recorded." revealed={revealed} render={(r, show) => <>
          <div className="flex justify-between gap-3"><span className="font-semibold">Agent Advance</span><Badge variant="outline">{label(text(r.status))}</Badge></div><p className="mt-3 text-2xl font-bold"><Amount value={r.outstanding_balance} revealed={show} /></p><p className="text-xs text-muted-foreground">Outstanding from <Amount value={r.principal} revealed={show} /> principal · issued {date(r.issued_at)}</p>
        </>} /></section>
        <section><h3 className="mb-3 flex items-center gap-2 font-semibold"><BriefcaseBusiness className="h-4 w-4 text-primary" />Business Advances</h3><RecordList items={businessAdvances} empty="No Business Advances recorded." revealed={revealed} render={(r, show) => <>
          <div className="flex justify-between gap-3"><span className="font-semibold">{text(r.business_name, 'Business Advance')}</span><Badge variant="outline">{label(text(r.status))}</Badge></div><p className="mt-3 text-2xl font-bold"><Amount value={r.outstanding_balance} revealed={show} /></p><p className="text-xs text-muted-foreground">Outstanding · principal <Amount value={r.principal} revealed={show} /></p>
        </>} /></section>
        <section><h3 className="mb-3 flex items-center gap-2 font-semibold"><ReceiptText className="h-4 w-4 text-primary" />Other obligations</h3><RecordList items={obligations} empty="No CFO debit obligations recorded." revealed={revealed} render={(r, show) => <>
          <div className="flex justify-between gap-3"><span className="font-semibold">{text(r.reason, 'Account obligation')}</span><Badge variant="outline">{label(text(r.status))}</Badge></div><p className="mt-3 text-2xl font-bold"><Amount value={r.outstanding} revealed={show} /></p><p className="text-xs text-muted-foreground">Original amount <Amount value={r.amount} revealed={show} /> · {date(r.created_at)}</p>
        </>} /></section>
        {advanceRequests.length > 0 && <section><h3 className="mb-3 font-semibold">Advance requests</h3><RecordList items={advanceRequests} empty="No requests." revealed={revealed} render={(r, show) => <><div className="flex justify-between"><span className="font-semibold">{label(text(r.request_kind, 'Advance request'))}</span><Badge variant="outline">{label(text(r.status))}</Badge></div><p className="mt-3 font-bold"><Amount value={r.total_payable} revealed={show} /></p><p className="text-xs text-muted-foreground">Requested {date(r.created_at)}</p></>} /></section>}
      </TabsContent>

      <TabsContent value="partnerships" className="space-y-6">
        <section><h3 className="mb-3 flex items-center gap-2 font-semibold"><Landmark className="h-4 w-4 text-primary" />Supporter portfolios</h3><RecordList items={portfolios} empty="No Supporter portfolios recorded." revealed={revealed} render={(r, show) => <>
          <div className="flex justify-between gap-3"><span className="font-semibold">{text(r.portfolio_code, 'Supporter portfolio')}</span><Badge variant="outline">{label(text(r.status))}</Badge></div><p className="mt-3 text-2xl font-bold"><Amount value={r.investment_amount} revealed={show} /></p><div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground"><span>{text(r.returns_percentage, '0')}% Returns</span><span>{text(r.duration_months, '0')} months</span><span>Matures {date(r.maturity_date)}</span><span>Earned <Amount value={r.total_returns_earned} revealed={show} /></span></div>
        </>} /></section>
        <section><h3 className="mb-3 flex items-center gap-2 font-semibold"><Building2 className="h-4 w-4 text-primary" />Angel Pool shares</h3><RecordList items={shares} empty="No Angel Pool shares recorded." revealed={revealed} render={(r, show) => <>
          <div className="flex justify-between gap-3"><span className="font-semibold">{text(r.shares, '0')} shares</span><Badge variant="outline">{label(text(r.status))}</Badge></div><p className="mt-3 text-2xl font-bold"><Amount value={r.amount} revealed={show} /></p><p className="text-xs text-muted-foreground">Pool ownership {text(r.pool_ownership_percent, '0')}% · recorded {date(r.created_at)}</p>
        </>} /></section>
      </TabsContent>

      <TabsContent value="ai" className="space-y-4">
        <div className="flex items-center gap-3"><span className="rounded-md bg-primary/10 p-2 text-primary"><Fingerprint className="h-5 w-5" /></span><div><h3 className="font-semibold">Welile AI ID details</h3><p className="text-sm text-muted-foreground">Trust, payment, network, verification and behavior signals.</p></div></div>
        <KeyValues data={data.trust_profile} revealed={revealed} />
      </TabsContent>
    </Tabs>
  </div>;
}
