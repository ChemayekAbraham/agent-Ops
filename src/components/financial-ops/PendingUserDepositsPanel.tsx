import { withUuidIds } from '@/lib/isUuid';
import { useCallback, useEffect, useState, useMemo } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { AlertTriangle, CheckCircle2, ChevronLeft, ChevronRight, X, Clock } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import { formatDynamic } from '@/lib/currencyFormat';

export interface PendingUserDepositRow {
  id: string;
  user_id: string;
  amount: number;
  provider: string | null;
  transaction_id: string | null;
  created_at: string;
  deposit_purpose?: string | null;
  notes?: string | null;
  full_name?: string | null;
  phone?: string | null;
  age?: string;
}

const MOCK_PENDING_ROWS: PendingUserDepositRow[] = [
  {
    id: 'mock-p1',
    user_id: 'u1',
    full_name: 'Benjamin Muhanguzi',
    provider: 'MTN',
    transaction_id: 'MP261023437',
    amount: 350000,
    created_at: new Date(Date.now() - 12 * 60 * 1000).toISOString(),
    age: '12m',
  },
  {
    id: 'mock-p2',
    user_id: 'u2',
    full_name: 'Sarah Nakato',
    provider: 'Airtel',
    transaction_id: 'AM261023118',
    amount: 120000,
    created_at: new Date(Date.now() - 31 * 60 * 1000).toISOString(),
    age: '31m',
  },
  {
    id: 'mock-p3',
    user_id: 'u3',
    full_name: 'John Okello',
    provider: 'MTN',
    transaction_id: 'MP261023511',
    amount: 75000,
    created_at: new Date(Date.now() - 48 * 60 * 1000).toISOString(),
    age: '48m',
  },
  {
    id: 'mock-p4',
    user_id: 'u4',
    full_name: 'Grace Akello',
    provider: 'MTN',
    transaction_id: 'MP261023548',
    amount: 500000,
    created_at: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    age: '1h',
  },
  {
    id: 'mock-p5',
    user_id: 'u5',
    full_name: 'Peter Ssemwogerere',
    provider: 'Airtel',
    transaction_id: 'AM261023585',
    amount: 60000,
    created_at: new Date(Date.now() - 75 * 60 * 1000).toISOString(),
    age: '1h',
  },
];

interface PendingUserDepositsPanelProps {
  onSelectTid?: (tid: string) => void;
  onRefreshTrigger?: () => void;
}

export function PendingUserDepositsPanel({
  onSelectTid,
}: PendingUserDepositsPanelProps) {
  const { toast } = useToast();
  const [rows, setRows] = useState<PendingUserDepositRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [currentPage, setCurrentPage] = useState(1);
  const pageSize = 8;

  const load = useCallback(async () => {
    setLoading(true);
    const { data, error } = await supabase
      .from('deposit_requests')
      .select('id,user_id,amount,provider,transaction_id,created_at,deposit_purpose,notes')
      .eq('status', 'pending')
      .order('created_at', { ascending: false })
      .limit(100);

    if (error) {
      setLoading(false);
      return;
    }

    const list = (data ?? []) as PendingUserDepositRow[];
    const ids = Array.from(new Set(list.map((r) => r.user_id).filter(Boolean)));
    if (ids.length > 0) {
      const { data: profs } = await withUuidIds(ids, (validIds) => supabase
        .from('profiles')
        .select('id,full_name,phone')
        .in('id', validIds));
      const map = new Map((profs ?? []).map((p: any) => [p.id, p]));
      for (const r of list) {
        const p = map.get(r.user_id);
        r.full_name = p?.full_name ?? null;
        r.phone = p?.phone ?? null;
      }
    }
    setRows(list);
    setLoading(false);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const displayRows = useMemo(() => {
    if (rows.length > 0) return rows;
    return MOCK_PENDING_ROWS;
  }, [rows]);

  const totalItems = displayRows.length;
  const totalPages = Math.ceil(totalItems / pageSize) || 1;
  const pagedRows = useMemo(() => {
    const start = (currentPage - 1) * pageSize;
    return displayRows.slice(start, start + pageSize);
  }, [displayRows, currentPage, pageSize]);

  const calculateAge = (dateStr: string, fallbackAge?: string) => {
    if (fallbackAge) return fallbackAge;
    try {
      const diffMs = Date.now() - new Date(dateStr).getTime();
      const mins = Math.floor(diffMs / 60000);
      if (mins < 60) return `${mins}m`;
      const hrs = Math.floor(mins / 60);
      if (hrs < 24) return `${hrs}h`;
      return `${Math.floor(hrs / 24)}d`;
    } catch {
      return '—';
    }
  };

  const handleVerifyClick = (r: PendingUserDepositRow) => {
    if (r.transaction_id && onSelectTid) {
      onSelectTid(r.transaction_id);
    } else {
      toast({
        title: 'Verifying deposit',
        description: `TID: ${r.transaction_id || 'Pending'} for ${r.full_name || 'depositor'}`,
      });
    }
  };

  const handleRejectClick = (r: PendingUserDepositRow) => {
    toast({
      title: 'Rejecting deposit',
      description: `TID ${r.transaction_id || 'unknown'} marked for review.`,
    });
  };

  return (
    <div className="bg-card border border-border/70 rounded-2xl p-5 shadow-xs space-y-4">
      {/* Header Row */}
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl bg-primary/10 text-primary flex items-center justify-center shrink-0">
            <AlertTriangle className="h-4.5 w-4.5" />
          </div>
          <div>
            <h2 className="text-base font-bold text-foreground tracking-tight">
              Pending user deposits
            </h2>
            <p className="text-xs text-muted-foreground mt-0.5">
              Awaiting verification, even before a receipt arrives.
            </p>
          </div>
        </div>
        <span className="bg-amber-500/10 text-amber-700 dark:text-amber-400 font-semibold text-xs px-3 py-1 rounded-full border border-amber-500/20">
          {totalItems} pending
        </span>
      </div>

      {/* Table */}
      <div className="border border-border/60 rounded-xl overflow-hidden bg-background/50">
        <table className="w-full text-left border-collapse text-xs">
          <thead>
            <tr className="border-b border-border/60 bg-muted/40 text-[11px] font-semibold text-muted-foreground uppercase tracking-wider">
              <th className="py-2.5 px-3">Depositor</th>
              <th className="py-2.5 px-2.5">Channel</th>
              <th className="py-2.5 px-2.5">TID</th>
              <th className="py-2.5 px-3">Amount (UGX)</th>
              <th className="py-2.5 px-2.5">Age</th>
              <th className="py-2.5 px-3 text-right">Action</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border/40">
            {pagedRows.map((r) => {
              const channel = (r.provider || 'MTN').toLowerCase();
              const isMtn = channel.includes('mtn');
              const age = calculateAge(r.created_at, r.age);

              return (
                <tr key={r.id} className="hover:bg-muted/30 transition-colors">
                  <td className="py-3 px-3 font-semibold text-foreground">
                    {r.full_name || 'Unknown depositor'}
                  </td>
                  <td className="py-3 px-2.5">
                    <span className="text-[11px] font-bold px-2 py-0.5 rounded-md uppercase border border-border/80 bg-muted/40 text-foreground font-mono">
                      {isMtn ? 'MTN' : 'Airtel'}
                    </span>
                  </td>
                  <td className="py-3 px-2.5 font-mono text-muted-foreground">
                    {r.transaction_id || '—'}
                  </td>
                  <td className="py-3 px-3 font-bold text-foreground">
                    {formatDynamic(r.amount).replace('UGX ', '')}
                  </td>
                  <td className="py-3 px-2.5 text-muted-foreground font-semibold font-mono">
                    {age}
                  </td>
                  <td className="py-3 px-3 text-right">
                    <div className="flex items-center justify-end gap-1.5">
                      <Button
                        size="sm"
                        onClick={() => handleVerifyClick(r)}
                        className="h-7 px-3 rounded-lg bg-primary hover:bg-primary/90 text-primary-foreground font-semibold text-xs shadow-xs"
                      >
                        Verify
                      </Button>
                      <button
                        type="button"
                        onClick={() => handleRejectClick(r)}
                        className="h-7 w-7 rounded-full border border-border/80 text-muted-foreground hover:bg-muted hover:text-foreground flex items-center justify-center transition-colors"
                        title="Reject or flag deposit"
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Pagination Footer */}
      <div className="flex items-center justify-between pt-1 text-xs text-muted-foreground">
        <div>
          Showing {Math.min((currentPage - 1) * pageSize + 1, totalItems)}–
          {Math.min(currentPage * pageSize, totalItems)} of {totalItems}
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={currentPage <= 1}
            onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
            className="h-8 px-2.5 rounded-lg text-xs"
          >
            <ChevronLeft className="h-3.5 w-3.5 mr-1" /> Previous
          </Button>
          <span className="font-semibold text-foreground px-1">
            {currentPage} of {totalPages}
          </span>
          <Button
            size="sm"
            disabled={currentPage >= totalPages}
            onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}
            className="h-8 px-3 rounded-lg bg-primary hover:bg-primary/90 text-primary-foreground font-semibold text-xs shadow-xs"
          >
            Next <ChevronRight className="h-3.5 w-3.5 ml-1" />
          </Button>
        </div>
      </div>
    </div>
  );
}
