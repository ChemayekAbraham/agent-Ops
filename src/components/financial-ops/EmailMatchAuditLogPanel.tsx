import { useCallback, useEffect, useMemo, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import {
  ScrollText, Loader2, RefreshCw, Search, X, Bot, UserCheck, Link2, ShieldCheck,
  Layers, SkipForward, Ban,
} from 'lucide-react';
import { format } from 'date-fns';
import { useToast } from '@/hooks/use-toast';
import { cn } from '@/lib/utils';

interface AuditRow {
  id: string;
  gmail_transaction_id: string | null;
  deposit_request_id: string | null;
  action: 'auto_claim' | 'unclaim' | 'manual_link' | 'approve' | 'bulk_approve' | 'skip' | 'auto_reject' | 'tid_auto_credited';
  matcher_type: string | null;
  match_score: number | null;
  signals: any;
  amount: number | null;
  actor_id: string | null;
  actor_email: string | null;
  notes: string | null;
  created_at: string;
  actor_name?: string | null;
}

const fmtUgx = (n: number | null | undefined) =>
  n == null ? '—' : `UGX ${Math.round(n).toLocaleString()}`;

const actionConfig: Record<AuditRow['action'], { label: string; icon: any; cls: string }> = {
  auto_claim:  { label: 'Auto-claimed',   icon: Bot,         cls: 'bg-sky-500/15 text-sky-700 border-sky-500/30' },
  manual_link: { label: 'Manual link',    icon: Link2,       cls: 'bg-violet-500/15 text-violet-700 border-violet-500/30' },
  approve:     { label: 'Approved',       icon: ShieldCheck, cls: 'bg-emerald-500/15 text-emerald-700 border-emerald-500/30' },
  bulk_approve:{ label: 'Bulk approved',  icon: Layers,      cls: 'bg-emerald-500/15 text-emerald-700 border-emerald-500/30' },
  skip:        { label: 'Skipped',        icon: SkipForward, cls: 'bg-amber-500/15 text-amber-700 border-amber-500/30' },
  unclaim:     { label: 'Unclaimed',      icon: X,           cls: 'bg-muted text-muted-foreground border-border' },
  auto_reject: { label: 'Auto-rejected',  icon: Ban,         cls: 'bg-rose-500/15 text-rose-700 border-rose-500/30' },
  tid_auto_credited: { label: 'Already credited (TID)', icon: ShieldCheck, cls: 'bg-emerald-600/15 text-emerald-700 border-emerald-600/40' },
};

/**
 * Regulator-safe audit feed for the email auto-match engine.
 * Renders every claim / link / approve / skip step with matcher type,
 * signals, score, approver and timestamp. Read-only.
 */
export function EmailMatchAuditLogPanel() {
  const { toast } = useToast();
  const [rows, setRows] = useState<AuditRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [actionFilter, setActionFilter] = useState<'all' | AuditRow['action']>('all');
  const [search, setSearch] = useState('');

  const load = useCallback(async (silent = false) => {
    if (silent) setRefreshing(true); else setLoading(true);
    try {
      const { data, error } = await (supabase.from('email_match_audit_log') as any)
        .select('*')
        .order('created_at', { ascending: false })
        .limit(300);
      if (error) throw error;
      const audit: AuditRow[] = (data as AuditRow[]) ?? [];
      // Hydrate actor names from profiles (best-effort)
      const actorIds = Array.from(new Set(audit.map((r) => r.actor_id).filter(Boolean))) as string[];
      let pmap = new Map<string, string>();
      if (actorIds.length) {
        const { data: profs } = await supabase.from('profiles').select('id, full_name, email').in('id', actorIds);
        (profs ?? []).forEach((p: any) => pmap.set(p.id, p.full_name ?? p.email ?? p.id.slice(0, 8)));
      }
      setRows(audit.map((r) => ({ ...r, actor_name: r.actor_id ? (pmap.get(r.actor_id) ?? r.actor_email ?? null) : null })));
    } catch (e: any) {
      if (!silent) toast({ title: 'Failed to load audit log', description: e?.message ?? 'Unknown error', variant: 'destructive' });
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [toast]);

  useEffect(() => { load(); }, [load]);

  // Realtime: append new rows live so operators see activity instantly.
  useEffect(() => {
    const ch = supabase
      .channel('email-match-audit-feed')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'email_match_audit_log' }, () => {
        load(true);
      })
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  }, [load]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows.filter((r) => {
      if (actionFilter !== 'all' && r.action !== actionFilter) return false;
      if (!q) return true;
      return (
        r.gmail_transaction_id?.toLowerCase().includes(q)
        || r.deposit_request_id?.toLowerCase().includes(q)
        || r.actor_name?.toLowerCase().includes(q)
        || r.actor_email?.toLowerCase().includes(q)
        || r.matcher_type?.toLowerCase().includes(q)
        || r.notes?.toLowerCase().includes(q)
      );
    });
  }, [rows, actionFilter, search]);

  const counts = useMemo(() => {
    const c: Record<string, number> = { all: rows.length };
    rows.forEach((r) => { c[r.action] = (c[r.action] ?? 0) + 1; });
    return c;
  }, [rows]);

  const exportCsv = () => {
    const header = ['timestamp','action','matcher_type','match_score','signals','amount','gmail_transaction_id','deposit_request_id','actor','notes'];
    const escape = (v: any) => {
      if (v == null) return '';
      const s = typeof v === 'string' ? v : JSON.stringify(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const lines = [
      header.join(','),
      ...filtered.map((r) => [
        r.created_at, r.action, r.matcher_type ?? '', r.match_score ?? '',
        r.signals ? JSON.stringify(r.signals) : '',
        r.amount ?? '', r.gmail_transaction_id ?? '', r.deposit_request_id ?? '',
        r.actor_name ?? r.actor_email ?? (r.actor_id ?? 'system'),
        r.notes ?? '',
      ].map(escape).join(',')),
    ];
    const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const filename = `email-match-audit-${format(new Date(), 'yyyyMMdd-HHmm')}.csv`;
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);

    // Bulk export of many email-matching audit rows at once, not logged
    // before this. Plain client-side insert so the audit_logs IP-capture
    // trigger sees the real browser IP directly. Never blocks the actual
    // download.
    (async () => {
      try {
        const { data: { user } } = await supabase.auth.getUser();
        await supabase.from('audit_logs').insert({
          user_id: user?.id ?? null,
          action_type: 'csv_exported',
          table_name: 'email_match_audit',
          record_id: null,
          metadata: { filename, row_count: filtered.length },
        });
      } catch (e) {
        console.warn('[EmailMatchAuditLogPanel] audit log insert failed:', e);
      }
    })();
  };

  return (
    <div className="rounded-xl border bg-card overflow-hidden">
      <div className="p-4 border-b bg-gradient-to-r from-slate-500/5 to-transparent flex flex-col gap-3">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div>
            <h3 className="font-semibold text-sm sm:text-base flex items-center gap-2">
              <ScrollText className="h-4 w-4 text-primary" />
              Match audit log
            </h3>
            <p className="text-xs text-muted-foreground mt-0.5">
              Regulator-safe record of every auto-detection, link, approval and skip — with matcher type, signals, approver and timestamp.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={exportCsv} disabled={filtered.length === 0}>
              Export CSV
            </Button>
            <Button variant="outline" size="sm" onClick={() => load(true)} disabled={refreshing} className="gap-2">
              {refreshing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
              Refresh
            </Button>
          </div>
        </div>

        <div className="flex flex-wrap gap-1.5">
          {(['all','auto_claim','tid_auto_credited','manual_link','approve','bulk_approve','skip','unclaim','auto_reject'] as const).map((k) => (
            <button
              key={k}
              type="button"
              onClick={() => setActionFilter(k)}
              className={cn(
                'text-[11px] px-2 py-1 rounded-md border transition-colors',
                actionFilter === k ? 'bg-primary text-primary-foreground border-primary' : 'bg-background hover:bg-muted border-border'
              )}
            >
              {k === 'all' ? 'All' : actionConfig[k].label}
              <span className="ml-1 opacity-70">({counts[k] ?? 0})</span>
            </button>
          ))}
        </div>

        <div className="relative">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Filter by email ID, deposit ID, approver, matcher type, notes…"
            className="pl-7 h-9 text-xs"
          />
          {search && (
            <button type="button" onClick={() => setSearch('')} className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground">
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      </div>

      {loading ? (
        <div className="p-6 text-center text-sm text-muted-foreground">
          <Loader2 className="h-5 w-5 animate-spin mx-auto mb-2" />
          Loading audit trail…
        </div>
      ) : filtered.length === 0 ? (
        <div className="p-8 text-center text-sm text-muted-foreground">
          <ScrollText className="h-8 w-8 mx-auto mb-2 text-muted-foreground/40" />
          No audit entries match the current filters yet.
        </div>
      ) : (
        <ul className="divide-y max-h-[640px] overflow-y-auto">
          {filtered.map((r) => {
            const cfg = actionConfig[r.action];
            const Icon = cfg.icon;
            const signals: string[] = Array.isArray(r.signals)
              ? r.signals
              : (r.signals && typeof r.signals === 'object' && Array.isArray((r.signals as any).signals))
                ? (r.signals as any).signals
                : [];
            const isSystem = !r.actor_id;
            return (
              <li key={r.id} className="p-3 text-xs space-y-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <Badge variant="outline" className={cn('gap-1 text-[10px]', cfg.cls)}>
                    <Icon className="h-3 w-3" /> {cfg.label}
                  </Badge>
                  {r.matcher_type && (
                    <Badge variant="secondary" className="text-[10px] uppercase">
                      {r.matcher_type === 'tid' ? 'TID' : r.matcher_type.replace('_', ' ')}
                    </Badge>
                  )}
                  {r.match_score != null && r.match_score > 0 && (
                    <Badge variant="outline" className="text-[10px]">score {r.match_score}</Badge>
                  )}
                  {r.amount != null && (
                    <span className="font-semibold">{fmtUgx(r.amount)}</span>
                  )}
                  <span className="text-muted-foreground ml-auto">
                    {format(new Date(r.created_at), 'dd MMM yyyy HH:mm:ss')}
                  </span>
                </div>

                <div className="flex items-center gap-1.5 text-muted-foreground">
                  {isSystem ? (
                    <><Bot className="h-3 w-3" /> <span>System (auto-matcher)</span></>
                  ) : (
                    <><UserCheck className="h-3 w-3" /> <span className="text-foreground font-medium">{r.actor_name ?? r.actor_email ?? r.actor_id?.slice(0, 8)}</span></>
                  )}
                </div>

                {signals.length > 0 && (
                  <div className="flex flex-wrap gap-1">
                    {signals.map((s) => (
                      <Badge key={s} variant="outline" className="text-[10px] py-0 px-1.5 font-normal">✓ {s}</Badge>
                    ))}
                  </div>
                )}

                <div className="font-mono text-[10px] text-muted-foreground space-y-0.5">
                  {r.gmail_transaction_id && <div>email: {r.gmail_transaction_id}</div>}
                  {r.deposit_request_id && <div>deposit: {r.deposit_request_id}</div>}
                </div>

                {r.notes && <div className="text-[11px] italic text-muted-foreground">{r.notes}</div>}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
