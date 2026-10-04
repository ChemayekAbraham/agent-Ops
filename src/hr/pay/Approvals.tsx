/**
 * Approvals inbox. What appears here is decided by the position the signed-in
 * user holds (hr_my_approvals), never by their role.
 */
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Loader2 } from 'lucide-react';
import HRPlaceholderPage from '@/hr/pages/HRPlaceholderPage';
import { Card, CardContent } from '@/components/ui/card';
import { myApprovals, myPayrollAuthority } from '@/hr/pay/api/workflow';

interface ApprovalItem {
  item_type: string;
  item_id: string;
  title: string;
  detail: string | null;
  raised_by: string | null;
  raised_at: string | null;
  action_required: string | null;
  route: string | null;
}

interface PayrollAuthority {
  preparer: boolean;
  approver: boolean;
  releaser: boolean;
}

export default function Approvals() {
  const [items, setItems] = useState<ApprovalItem[]>([]);
  const [names, setNames] = useState<Record<string, string>>({});
  const [authority, setAuthority] = useState<PayrollAuthority | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    (async () => {
      const rowsPromise = myApprovals();
      const authPromise = myPayrollAuthority().catch((err) => {
        // Authority discovery is diagnostic; don't block the inbox on it.
        // eslint-disable-next-line no-console
        console.error('myPayrollAuthority failed', err);
        return null;
      });
      const [rows, auth] = await Promise.all([rowsPromise, authPromise]);
      if (!alive) return;
      setItems(rows as ApprovalItem[]);
      setAuthority(auth);
      const ids = Array.from(new Set(rows.map((r) => r.raised_by).filter(Boolean))) as string[];
      if (ids.length > 0) {
        const { supabase } = await import('@/hr/api/client');
        const { data } = await supabase.from('profiles').select('id, full_name').in('id', ids);
        if (!alive) return;
        const map: Record<string, string> = {};
        (data ?? []).forEach((p: any) => {
          if (p.full_name) map[p.id] = p.full_name;
        });
        setNames(map);
      }
    })()
      .catch((err) => {
        if (alive) setError((err as Error).message);
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, []);

  const authorityLabels = authority
    ? [
        authority.preparer ? 'prepare authority' : '',
        authority.approver ? 'approve authority' : '',
        authority.releaser ? 'release authority' : '',
      ].filter(Boolean)
    : [];

  return (
    <HRPlaceholderPage
      heading="Approvals"
      subtitle="Items waiting on you. This list reflects the position you hold, not your role."
    >
      {!loading && authority && (
        <>
          {authorityLabels.length > 0 ? (
            <p className="text-sm text-muted-foreground">
              You hold: {authorityLabels.join(', ')}
            </p>
          ) : (
            <div className="rounded-md border border-amber-200 bg-amber-50 p-4">
              <p className="text-sm font-semibold text-amber-900">You hold no payroll authority</p>
              <p className="mt-1 text-xs text-amber-800">
                This inbox shows work assigned to the position you hold in the organisation chart,
                not to your role. Payroll items appear here for the positions holding prepare,
                approve or release authority. If you believe you should see items here, ask HR to
                check your position assignment.
              </p>
            </div>
          )}
        </>
      )}
      {loading && (
        <p className="text-sm text-muted-foreground">
          <Loader2 className="mr-1 inline h-3.5 w-3.5 animate-spin" />
          Loading…
        </p>
      )}
      {error && (
        <p role="alert" className="text-sm font-medium text-destructive">
          {error}
        </p>
      )}
      {!loading && !error && items.length === 0 && authorityLabels.length > 0 && (
        <Card>
          <CardContent className="py-8 text-center">
            <p className="text-sm font-semibold">Nothing waiting on you right now.</p>
            <p className="mt-1 text-xs text-muted-foreground">
              Items appear here when a run reaches the stage your position is responsible for.
            </p>
          </CardContent>
        </Card>
      )}
      <div className="space-y-3">
        {items.map((item) => {
          const provisional = (item.detail ?? '').includes('PROVISIONAL');
          const isAdvance = item.item_type === 'advance';
          const body = (
            <CardContent className="space-y-1 py-4">
              <div className="flex items-center gap-2">
                <p className="text-sm font-semibold">{item.title}</p>
                {isAdvance && (
                  <span className="inline-flex rounded-full bg-blue-100 px-2 py-0.5 text-[10px] font-semibold text-blue-800">
                    SALARY ADVANCE
                  </span>
                )}
                {provisional && (
                  <span className="inline-flex rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-semibold text-amber-800">
                    PROVISIONAL
                  </span>
                )}
              </div>
              {item.detail && <p className="text-xs text-muted-foreground">{item.detail}</p>}
              {item.action_required && (
                <p className="text-xs font-medium">{item.action_required}</p>
              )}
              <p className="text-[11px] text-muted-foreground">
                Raised by {(item.raised_by && names[item.raised_by]) || 'System'}
                {item.raised_at ? ` · ${new Date(item.raised_at).toLocaleString('en-GB')}` : ''}
              </p>
            </CardContent>
          );
          return item.route ? (
            <Link key={`${item.item_type}-${item.item_id}`} to={item.route} className="block">
              <Card className="transition-colors hover:bg-muted/40">{body}</Card>
            </Link>
          ) : (
            <Card key={`${item.item_type}-${item.item_id}`}>{body}</Card>
          );
        })}
      </div>
    </HRPlaceholderPage>
  );
}
