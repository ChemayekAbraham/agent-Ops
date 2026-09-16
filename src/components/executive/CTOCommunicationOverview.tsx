import { useState, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ExecutiveDataTable, Column } from './ExecutiveDataTable';
import { CTOEmailsOverview } from './CTOEmailsOverview';
import { PartnerSMSBroadcast } from './PartnerSMSBroadcast';
import { AudienceSMSBroadcast } from './AudienceSMSBroadcast';
import { COOPartnerBroadcast } from '@/components/coo/COOPartnerBroadcast';
import {
  MessageSquare,
  Mail,
  Search,
  Users,
  AlertTriangle,
  ShieldCheck,
  Megaphone,
  BellRing,
  Send,
  CheckCircle2,
  ShieldAlert,
} from 'lucide-react';
import { KPICard } from './KPICard';
import { format, subDays } from 'date-fns';
import { cn } from '@/lib/utils';
import {
  useTenantNotificationPerformance,
  TenantNotificationEventPerformance,
} from '@/hooks/useTenantNotificationAnalytics';

type Partner = {
  id: string;
  full_name: string | null;
  phone: string | null;
  email: string | null;
  created_at: string;
  last_active_at: string | null;
  portfolios?: number;
};

const isInvalidEmail = (email: string | null | undefined) => {
  if (!email) return true;
  const e = email.trim().toLowerCase();
  if (!e) return true;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) return true;
  // Fallback / system-generated emails are not real inboxes
  if (e.includes('@noapp.welile.user')) return true;
  return false;
};

const isValidPhone = (phone: string | null | undefined) => {
  if (!phone) return false;
  const p = phone.trim();
  if (!p || p === '-') return false;
  // require at least 7 digits anywhere in the string
  const digits = p.replace(/\D/g, '');
  return digits.length >= 7;
};

const EVENT_LABELS: Record<string, string> = {
  PAYMENT_FULL: 'Payment received',
  PAYMENT_PARTIAL: 'Partial payment',
  PAYMENT_MISSED: 'Missed payment',
  FIVE_DAY_AGENT_OPPORTUNITY: '5-Day default (Agent opportunity)',
  RENT_LIMIT_PROGRESS: 'Rent limit progress',
  RENT_LIMIT_INCREASED: 'Rent limit increased',
  TENANT_RELOCATION: 'Tenant relocation',
  MERCHANT_CODE_REMINDER: 'Merchant code reminder',
  DASHBOARD_INVITE: 'Dashboard invite',
  SMARTPHONE_DISCOVERY: 'Smartphone discovery',
  DASHBOARD_ACTIVATED: 'Dashboard activated',
  PUSH_MIGRATION: 'Push notifications enabled',
};

function humanizeEventKey(key: string): string {
  if (EVENT_LABELS[key]) return EVENT_LABELS[key];
  return key
    .split('_')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(' ');
}

function TenantNotificationsTab() {
  const [daysRange, setDaysRange] = useState<7 | 30>(7);

  const startDate = useMemo(() => {
    return format(subDays(new Date(), daysRange === 7 ? 6 : 29), 'yyyy-MM-dd');
  }, [daysRange]);

  const endDate = useMemo(() => {
    return format(new Date(), 'yyyy-MM-dd');
  }, []);

  const { data, isLoading } = useTenantNotificationPerformance({
    startDate,
    endDate,
  });

  const totals = data?.totals;

  const sortedEvents = useMemo(() => {
    const list = data?.by_event ? [...data.by_event] : [];
    return list.sort((a, b) => (b.sent ?? 0) - (a.sent ?? 0));
  }, [data?.by_event]);

  const columns: Column<TenantNotificationEventPerformance>[] = [
    {
      key: 'event_key',
      label: 'Event',
      render: (_, row) => (
        <div className="min-w-0">
          <div className="font-semibold text-foreground">{humanizeEventKey(row.event_key)}</div>
          <div className="text-[11px] font-mono text-muted-foreground">{row.event_key}</div>
        </div>
      ),
    },
    {
      key: 'sent',
      label: 'Sent',
      render: (v) => <span className="font-medium tabular-nums">{Number(v ?? 0).toLocaleString()}</span>,
    },
    {
      key: 'delivered',
      label: 'Delivered',
      render: (v) => (
        <span className="text-emerald-600 dark:text-emerald-400 font-medium tabular-nums">
          {Number(v ?? 0).toLocaleString()}
        </span>
      ),
    },
    {
      key: 'failed',
      label: 'Failed',
      render: (v) => {
        const n = Number(v ?? 0);
        return (
          <span className={cn('tabular-nums', n > 0 ? 'text-destructive font-medium' : 'text-muted-foreground')}>
            {n.toLocaleString()}
          </span>
        );
      },
    },
    {
      key: 'suppressed',
      label: 'Suppressed',
      render: (v) => <span className="text-muted-foreground tabular-nums">{Number(v ?? 0).toLocaleString()}</span>,
    },
    {
      key: 'unique_tenants',
      label: 'Unique Tenants',
      render: (v) => <span className="tabular-nums">{Number(v ?? 0).toLocaleString()}</span>,
    },
    {
      key: 'acted',
      label: 'Acted',
      render: (v) => <span className="font-medium text-foreground tabular-nums">{Number(v ?? 0).toLocaleString()}</span>,
    },
    {
      key: 'conversion_rate_pct',
      label: 'Conversion %',
      render: (v) => (
        <Badge variant="secondary" className="font-semibold bg-primary/10 text-primary tabular-nums">
          {Math.round(Number(v ?? 0))}%
        </Badge>
      ),
    },
  ];

  return (
    <div className="space-y-4 sm:space-y-6">
      {/* Header with Title, Date Range Subtitle & 7d/30d Picker */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h3 className="text-base font-semibold flex items-center gap-2">
            <BellRing className="h-4 w-4 text-primary" />
            Tenant Notifications
          </h3>
          <p className="text-xs text-muted-foreground mt-0.5">
            {daysRange === 7 ? 'Last 7 days' : 'Last 30 days'}
            {data?.start_date && data?.end_date ? ` (${data.start_date} – ${data.end_date})` : ''}
          </p>
        </div>

        {/* Date range toggle (7d / 30d) */}
        <div className="flex items-center gap-1 bg-muted/60 p-1 rounded-lg border border-border/50 self-start sm:self-auto">
          <Button
            type="button"
            variant={daysRange === 7 ? 'secondary' : 'ghost'}
            size="sm"
            className={cn(
              'h-7 px-2.5 text-xs transition-all',
              daysRange === 7 && 'bg-background shadow-xs font-semibold text-foreground',
            )}
            onClick={() => setDaysRange(7)}
          >
            Last 7d
          </Button>
          <Button
            type="button"
            variant={daysRange === 30 ? 'secondary' : 'ghost'}
            size="sm"
            className={cn(
              'h-7 px-2.5 text-xs transition-all',
              daysRange === 30 && 'bg-background shadow-xs font-semibold text-foreground',
            )}
            onClick={() => setDaysRange(30)}
          >
            Last 30d
          </Button>
        </div>
      </div>

      {/* KPI row: Sent, Delivered, Unique Tenants, Failed, Suppressed */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2 sm:gap-3">
        <KPICard
          title="Sent"
          value={(totals?.sent ?? 0).toLocaleString()}
          icon={Send}
          loading={isLoading}
        />
        <KPICard
          title="Delivered"
          value={(totals?.delivered ?? 0).toLocaleString()}
          icon={CheckCircle2}
          color="bg-emerald-500/10 text-emerald-600"
          subtitle={
            totals?.sent
              ? `${Math.round(((totals.delivered ?? 0) / totals.sent) * 100)}% delivered`
              : undefined
          }
          loading={isLoading}
        />
        <KPICard
          title="Unique Tenants"
          value={(totals?.unique_tenants ?? 0).toLocaleString()}
          icon={Users}
          color="bg-blue-500/10 text-blue-600"
          loading={isLoading}
        />
        <KPICard
          title="Failed"
          value={(totals?.failed ?? 0).toLocaleString()}
          icon={AlertTriangle}
          color={(totals?.failed ?? 0) > 0 ? 'bg-destructive/10 text-destructive' : 'bg-muted text-muted-foreground'}
          loading={isLoading}
        />
        <KPICard
          title="Suppressed"
          value={(totals?.suppressed ?? 0).toLocaleString()}
          icon={ShieldAlert}
          color="bg-amber-500/10 text-amber-600"
          subtitle="Frequency capped"
          loading={isLoading}
        />
      </div>

      {/* Per-event table driven by data.by_event */}
      <div className="space-y-2">
        <ExecutiveDataTable
          data={sortedEvents}
          columns={columns}
          loading={isLoading}
          title={`Tenant Notifications by Event (${sortedEvents.length})`}
        />
        <p className="text-xs text-muted-foreground italic px-1">
          Conversion = sent AND later acted within the attribution window — not causation.
        </p>
      </div>
    </div>
  );
}

export function CTOCommunicationOverview() {
  const [search, setSearch] = useState('');

  const { data: partners, isLoading } = useQuery({
    queryKey: ['cto-communication-partners'],
    queryFn: async () => {
      // A "partner" = a user who owns one or more investor portfolios.
      // Paginate to bypass the 1000-row default.
      const portfolioOwners = new Set<string>();
      const portfolioCount: Record<string, number> = {};
      const pageSize = 1000;
      let from = 0;
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const { data, error } = await supabase
          .from('investor_portfolios')
          .select('investor_id')
          .range(from, from + pageSize - 1);
        if (error) throw error;
        if (!data || data.length === 0) break;
        for (const r of data as any[]) {
          if (!r.investor_id) continue;
          portfolioOwners.add(r.investor_id);
          portfolioCount[r.investor_id] = (portfolioCount[r.investor_id] || 0) + 1;
        }
        if (data.length < pageSize) break;
        from += pageSize;
      }
      const ids = Array.from(portfolioOwners);
      if (ids.length === 0) return [] as Partner[];

      // Batch fetch profiles (chunks of 500 to be safe)
      const chunkSize = 500;
      const all: Partner[] = [];
      for (let i = 0; i < ids.length; i += chunkSize) {
        const slice = ids.slice(i, i + chunkSize);
        const { data, error } = await supabase
          .from('profiles')
          .select('id, full_name, phone, email, created_at, last_active_at')
          .in('id', slice);
        if (error) throw error;
        for (const p of (data || []) as Partner[]) {
          all.push({ ...p, portfolios: portfolioCount[p.id] || 0 } as Partner);
        }
      }
      return all;
    },
    staleTime: 5 * 60_000,
  });

  const { smsOnly, emailReachable } = useMemo(() => {
    const list = partners || [];
    return {
      // SMS tab: every partner reachable by phone (regardless of email).
      // Email tab handles the inbox-reachable subset separately.
      smsOnly: list.filter((p) => isValidPhone(p.phone)),
      // Email tab: partners with a real, deliverable email
      emailReachable: list.filter((p) => !isInvalidEmail(p.email)),
    };
  }, [partners]);

  const filtered = (rows: Partner[]) => {
    if (!search.trim()) return rows;
    const q = search.trim().toLowerCase();
    return rows.filter(
      (p) =>
        (p.full_name || '').toLowerCase().includes(q) ||
        (p.phone || '').toLowerCase().includes(q) ||
        (p.email || '').toLowerCase().includes(q),
    );
  };

  const baseColumns: Column<Partner>[] = [
    { key: 'full_name', label: 'Partner', render: (v) => (v as string) || '—' },
    { key: 'phone', label: 'Phone', render: (v) => (v as string) || '—' },
    {
      key: 'email',
      label: 'Email',
      render: (v) => {
        const e = (v as string) || '';
        if (!e) return <span className="text-muted-foreground italic">no email</span>;
        if (isInvalidEmail(e))
          return (
            <span className="text-amber-600 text-xs font-mono" title="Fallback / invalid email">
              {e}
            </span>
          );
        return <span className="text-xs font-mono">{e}</span>;
      },
    },
    {
      key: 'portfolios',
      label: 'Portfolios',
      render: (v) => <span className="font-medium">{Number(v ?? 0).toLocaleString()}</span>,
    },
    {
      key: 'last_active_at',
      label: 'Last Active',
      render: (v) => (v ? format(new Date(v as string), 'dd MMM yyyy') : '—'),
    },
    {
      key: 'created_at',
      label: 'Joined',
      render: (v) => (v ? format(new Date(v as string), 'dd MMM yyyy') : '—'),
    },
  ];

  const total = (partners || []).length;
  const smsCount = smsOnly.length;
  const emailCount = emailReachable.length;
  const noContact = (partners || []).filter((p) => isInvalidEmail(p.email) && !isValidPhone(p.phone)).length;

  return (
    <div className="space-y-4 sm:space-y-6">
      <div>
        <h2 className="text-lg font-semibold flex items-center gap-2">
          <MessageSquare className="h-5 w-5 text-primary" />
          Communication
        </h2>
        <p className="text-xs text-muted-foreground">
          Route messages to the right channel. SMS for partners without a valid email, Email for those reachable by inbox — prevents redundant sends.
        </p>
      </div>

      {/* KPIs */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-2 sm:gap-3">
        <KPICard
          title="Total Partners"
          value={total.toLocaleString()}
          icon={Users}
          loading={isLoading}
        />
        <KPICard
          title="SMS Only"
          value={smsCount.toLocaleString()}
          icon={MessageSquare}
          color="bg-amber-500/10 text-amber-600"
          subtitle="Reachable by phone"
          loading={isLoading}
        />
        <KPICard
          title="Email Reachable"
          value={emailCount.toLocaleString()}
          icon={Mail}
          color="bg-green-500/10 text-green-600"
          subtitle="Valid inbox on file"
          loading={isLoading}
        />
        <KPICard
          title="No Contact"
          value={noContact.toLocaleString()}
          icon={AlertTriangle}
          color={noContact > 0 ? 'bg-destructive/10 text-destructive' : 'bg-muted text-muted-foreground'}
          subtitle="No phone, no valid email"
          loading={isLoading}
        />
      </div>

      <Tabs defaultValue="broadcast" className="w-full">
        <TabsList variant="underline" className="w-full justify-start overflow-x-auto">
          <TabsTrigger value="broadcast" variant="underline" className="gap-2">
            <Megaphone className="h-4 w-4" />
            Broadcast
          </TabsTrigger>
          <TabsTrigger value="sms" variant="underline" className="gap-2">
            <MessageSquare className="h-4 w-4" />
            SMS
            <Badge variant="secondary" className="ml-1 h-5 px-1.5 text-[10px]">
              {smsCount}
            </Badge>
          </TabsTrigger>
          <TabsTrigger value="email" variant="underline" className="gap-2">
            <Mail className="h-4 w-4" />
            Email
            <Badge variant="secondary" className="ml-1 h-5 px-1.5 text-[10px]">
              {emailCount}
            </Badge>
          </TabsTrigger>
          <TabsTrigger value="tenant-notifications" variant="underline" className="gap-2">
            <BellRing className="h-4 w-4" />
            Tenant Notifications
          </TabsTrigger>
        </TabsList>

        <TabsContent value="broadcast" className="space-y-3">
          <AudienceSMSBroadcast />
        </TabsContent>

        <TabsContent value="sms" className="space-y-3">
          <PartnerSMSBroadcast />

          <div className="pt-2 border-t border-border" />

          <div className="flex items-center gap-2">
            <div className="relative flex-1 max-w-sm">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Search name, phone, email…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="pl-8 h-9"
              />
            </div>
            <span className="text-xs text-muted-foreground flex items-center gap-1">
              <AlertTriangle className="h-3.5 w-3.5 text-amber-600" />
              Partners with a phone number on file — reachable via SMS.
            </span>
          </div>
          <ExecutiveDataTable
            data={filtered(smsOnly)}
            columns={baseColumns}
            loading={isLoading}
            title={`Partners reachable by SMS (${smsCount.toLocaleString()})`}
          />
        </TabsContent>

        <TabsContent value="email" className="space-y-6">
          <COOPartnerBroadcast />

          <div className="pt-2 border-t border-border" />

          <div className="flex items-center gap-2">
            <div className="relative flex-1 max-w-sm">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Search name, phone, email…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="pl-8 h-9"
              />
            </div>
            <span className="text-xs text-muted-foreground flex items-center gap-1">
              <ShieldCheck className="h-3.5 w-3.5 text-green-600" />
              Safe to email — valid inbox addresses only.
            </span>
          </div>
          <ExecutiveDataTable
            data={filtered(emailReachable)}
            columns={baseColumns}
            loading={isLoading}
            title={`Partners with a valid email (${emailCount.toLocaleString()})`}
          />

          <div className="pt-2 border-t border-border">
            <CTOEmailsOverview />
          </div>
        </TabsContent>

        <TabsContent value="tenant-notifications" className="space-y-4">
          <TenantNotificationsTab />
        </TabsContent>
      </Tabs>
    </div>
  );
}
