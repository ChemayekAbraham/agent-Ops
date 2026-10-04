import { useEffect, useState } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Loader2, ArrowLeft, Copy, ExternalLink, ArrowUpRight, ArrowDownRight } from 'lucide-react';
import { format } from 'date-fns';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { formatDynamic as formatUGX } from '@/lib/currencyFormat';
import { CATEGORY_DESCRIPTIONS } from '@/lib/ledgerConstants';
import ScreenLoader from '@/components/common/ScreenLoader';

type LedgerEntry = {
  id: string;
  transaction_date: string;
  amount: number | string;
  direction: 'cash_in' | 'cash_out';
  category: string;
  ledger_scope: string;
  classification: string | null;
  account: string | null;
  user_id: string | null;
  description: string | null;
  reference_id: string | null;
  linked_party: string | null;
  transaction_group_id: string | null;
  source_table: string | null;
  source_id: string | null;
  metadata?: any;
  created_at?: string | null;
};

type Profile = { id: string; full_name: string | null; phone: string | null; email?: string | null };

const SCOPE_LABEL: Record<string, string> = { platform: 'Platform', wallet: 'User Custody', bridge: 'Bridge' };
const SCOPE_BADGE: Record<string, string> = {
  platform: 'bg-primary/10 text-primary border-primary/30',
  wallet:   'bg-amber-500/10 text-amber-600 border-amber-500/30',
  bridge:   'bg-purple-500/10 text-purple-600 border-purple-500/30',
};

function copy(value: string) {
  navigator.clipboard.writeText(value);
  toast.success('Copied');
}

function Field({ label, value, mono, copyable }: { label: string; value: React.ReactNode; mono?: boolean; copyable?: string }) {
  return (
    <div className="border-b border-border/60 py-2 last:border-0">
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className={cn('text-sm mt-0.5 flex items-start gap-2 break-all', mono && 'font-mono text-xs')}>
        <span className="flex-1">{value ?? <span className="text-muted-foreground/60">—</span>}</span>
        {copyable && (
          <button onClick={() => copy(copyable)} className="text-muted-foreground hover:text-primary shrink-0" title="Copy">
            <Copy className="h-3 w-3" />
          </button>
        )}
      </div>
    </div>
  );
}

export default function LedgerEntryDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [entry, setEntry] = useState<LedgerEntry | null>(null);
  const [siblings, setSiblings] = useState<LedgerEntry[]>([]);
  const [party, setParty] = useState<Profile | null>(null);
  const [sourceRow, setSourceRow] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    (async () => {
      setLoading(true); setNotFound(false);
      try {
        const { data, error } = await supabase
          .from('general_ledger')
          .select('*')
          .eq('id', id)
          .maybeSingle();
        if (error) throw error;
        if (!data) { if (!cancelled) setNotFound(true); return; }
        if (cancelled) return;
        setEntry(data as any);

        // Sibling legs (same transaction group)
        if ((data as any).transaction_group_id) {
          const { data: sibs } = await supabase
            .from('general_ledger')
            .select('id, transaction_date, amount, direction, category, ledger_scope, classification, account, user_id, description, reference_id, linked_party, transaction_group_id, source_table, source_id')
            .eq('transaction_group_id', (data as any).transaction_group_id)
            .order('direction', { ascending: true });
          if (!cancelled) setSiblings((sibs || []) as any);
        }

        // Party profile
        if ((data as any).user_id) {
          const { data: prof } = await supabase
            .from('profiles')
            .select('id, full_name, phone, email')
            .eq('id', (data as any).user_id)
            .maybeSingle();
          if (!cancelled) setParty(prof as any);
        }

        // Source row (best-effort)
        if ((data as any).source_table && (data as any).source_id) {
          try {
            const { data: src } = await supabase
              .from((data as any).source_table as any)
              .select('*')
              .eq('id', (data as any).source_id)
              .maybeSingle();
            if (!cancelled) setSourceRow(src);
          } catch {/* table may not be readable */}
        }
      } catch (err: any) {
        console.error('[LedgerEntryDetail]', err);
        toast.error('Failed to load ledger entry');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [id]);

  if (loading) return (
    <ScreenLoader />
  );

  if (notFound || !entry) return (
    <div className="min-h-screen flex flex-col items-center justify-center gap-3 p-6">
      <div className="text-lg font-semibold">Ledger entry not found</div>
      <div className="text-sm text-muted-foreground font-mono">{id}</div>
      <Button variant="outline" onClick={() => navigate(-1)} className="gap-2"><ArrowLeft className="h-4 w-4" /> Back</Button>
    </div>
  );

  const amt = Number(entry.amount) || 0;
  const isIn = entry.direction === 'cash_in';

  return (
    <div className="container max-w-4xl mx-auto px-4 py-6 space-y-4">
      {/* Header */}
      <div className="flex items-center gap-2">
        <Button variant="ghost" size="sm" onClick={() => navigate(-1)} className="gap-2"><ArrowLeft className="h-4 w-4" /> Back</Button>
        <div className="ml-auto text-[11px] text-muted-foreground font-mono">{entry.id}</div>
        <button onClick={() => copy(entry.id)} className="text-muted-foreground hover:text-primary"><Copy className="h-3.5 w-3.5" /></button>
      </div>

      {/* Hero */}
      <Card>
        <CardContent className="pt-5 pb-5">
          <div className="flex items-start justify-between gap-4 flex-wrap">
            <div>
              <div className="text-[11px] uppercase tracking-wider text-muted-foreground mb-1">Ledger Entry</div>
              <div className="text-xl font-semibold capitalize">{entry.category.replace(/_/g, ' ')}</div>
              {CATEGORY_DESCRIPTIONS[entry.category] && (
                <div className="text-xs text-muted-foreground mt-1 max-w-xl">{CATEGORY_DESCRIPTIONS[entry.category]}</div>
              )}
              <div className="flex items-center gap-2 mt-3">
                <Badge variant="outline" className={cn('text-[10px]', SCOPE_BADGE[entry.ledger_scope])}>
                  {SCOPE_LABEL[entry.ledger_scope] || entry.ledger_scope}
                </Badge>
                <Badge variant="outline" className={cn('text-[10px] gap-1', isIn ? 'text-success border-success/40' : 'text-destructive border-destructive/40')}>
                  {isIn ? <ArrowUpRight className="h-3 w-3" /> : <ArrowDownRight className="h-3 w-3" />}
                  {entry.direction.replace('_', ' ')}
                </Badge>
                {entry.classification && entry.classification !== 'production' && (
                  <Badge variant="outline" className="text-[10px]">{entry.classification}</Badge>
                )}
              </div>
            </div>
            <div className="text-right">
              <div className="text-[10px] uppercase text-muted-foreground">Amount</div>
              <div className={cn('text-2xl font-mono font-bold', isIn ? 'text-success' : 'text-destructive')}>
                {isIn ? '+' : '−'}{formatUGX(amt)}
              </div>
              <div className="text-[11px] text-muted-foreground mt-1">
                {format(new Date(entry.transaction_date), 'dd MMM yyyy · HH:mm:ss')}
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Identifiers */}
      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-sm">Identifiers</CardTitle></CardHeader>
        <CardContent className="pt-0">
          <Field label="Entry ID" value={entry.id} mono copyable={entry.id} />
          <Field label="Reference ID" value={entry.reference_id} mono copyable={entry.reference_id || undefined} />
          <Field label="Transaction Group" value={
            entry.transaction_group_id ? (
              <span className="font-mono">{entry.transaction_group_id}</span>
            ) : null
          } copyable={entry.transaction_group_id || undefined} />
          <Field label="Account" value={entry.account} mono />
        </CardContent>
      </Card>

      {/* Party */}
      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-sm">Party</CardTitle></CardHeader>
        <CardContent className="pt-0">
          <Field label="User" value={party?.full_name || party?.phone || (entry.user_id ? '(unknown)' : null)} />
          <Field label="User ID" value={entry.user_id} mono copyable={entry.user_id || undefined} />
          {party?.phone && <Field label="Phone" value={party.phone} mono />}
          {party?.email && <Field label="Email" value={party.email} />}
          <Field label="Linked Party" value={entry.linked_party} />
        </CardContent>
      </Card>

      {/* Source */}
      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-sm">Source</CardTitle></CardHeader>
        <CardContent className="pt-0">
          <Field label="Source Table" value={entry.source_table} mono />
          <Field label="Source ID" value={entry.source_id} mono copyable={entry.source_id || undefined} />
          {sourceRow && (
            <div className="mt-2">
              <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">Source Row</div>
              <pre className="bg-muted/40 rounded p-2 text-[10px] font-mono overflow-auto max-h-64 border border-border">
                {JSON.stringify(sourceRow, null, 2)}
              </pre>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Description & metadata */}
      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-sm">Description & Metadata</CardTitle></CardHeader>
        <CardContent className="pt-0">
          <Field label="Description" value={entry.description} />
          <Field label="Created At" value={entry.created_at ? format(new Date(entry.created_at), 'dd MMM yyyy HH:mm:ss') : null} />
          {entry.metadata && Object.keys(entry.metadata).length > 0 && (
            <div className="mt-2">
              <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">Metadata</div>
              <pre className="bg-muted/40 rounded p-2 text-[10px] font-mono overflow-auto max-h-64 border border-border">
                {JSON.stringify(entry.metadata, null, 2)}
              </pre>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Sibling legs */}
      {siblings.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Transaction Legs ({siblings.length})</CardTitle>
            <div className="text-[11px] text-muted-foreground">All ledger legs sharing transaction group <span className="font-mono">{entry.transaction_group_id?.slice(0, 12)}…</span></div>
          </CardHeader>
          <CardContent className="pt-0 space-y-1.5">
            {siblings.map(s => {
              const sIn = s.direction === 'cash_in';
              const sAmt = Number(s.amount) || 0;
              const isCurrent = s.id === entry.id;
              return (
                <Link
                  key={s.id}
                  to={`/cfo/ledger/${s.id}`}
                  className={cn(
                    'flex items-center justify-between gap-3 p-2 rounded border transition-colors',
                    isCurrent ? 'border-primary bg-primary/5' : 'border-border hover:bg-muted/40'
                  )}
                >
                  <div className="flex items-center gap-2 min-w-0">
                    <Badge variant="outline" className={cn('text-[10px] shrink-0', SCOPE_BADGE[s.ledger_scope])}>
                      {SCOPE_LABEL[s.ledger_scope] || s.ledger_scope}
                    </Badge>
                    <div className="min-w-0">
                      <div className="text-xs font-medium capitalize truncate">{s.category.replace(/_/g, ' ')}</div>
                      <div className="text-[10px] text-muted-foreground font-mono truncate">{s.id.slice(0, 8)}…</div>
                    </div>
                  </div>
                  <div className={cn('font-mono text-sm font-semibold whitespace-nowrap', sIn ? 'text-success' : 'text-destructive')}>
                    {sIn ? '+' : '−'}{formatUGX(sAmt)}
                  </div>
                  {!isCurrent && <ExternalLink className="h-3 w-3 text-muted-foreground shrink-0" />}
                </Link>
              );
            })}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
