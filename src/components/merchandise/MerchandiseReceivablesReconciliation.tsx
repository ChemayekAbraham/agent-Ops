import { useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Scale, ChevronDown, ChevronUp } from 'lucide-react';
import { formatUGX } from '@/lib/rentCalculations';
import { cn } from '@/lib/utils';
import {
  useMerchandiseReceivablesReconciliation,
  useMerchandiseReceivablesBalanceSheetTie,
  type MerchReconOrder,
} from '@/hooks/useMerchandiseReceivablesReconciliation';

const CATEGORY_LABEL: Record<string, string> = {
  boutique: 'Boutique', smart_phone: 'Smart phones', motor_bike: 'Bikes', signage: 'Signage',
};

function Line({ label, value, strong, sign, muted }: { label: string; value: number | null | undefined; strong?: boolean; sign?: '+' | '-' | '='; muted?: boolean }) {
  return (
    <div className={cn('flex items-baseline justify-between gap-3 py-1 text-sm', strong && 'border-t border-border pt-2 font-semibold', muted && 'text-muted-foreground')}>
      <span className="min-w-0">{sign ? <span className="mr-1 inline-block w-3 text-muted-foreground">{sign}</span> : null}{label}</span>
      <span className="shrink-0 tabular-nums">{value === null || value === undefined ? <Skeleton className="h-4 w-24" /> : formatUGX(value)}</span>
    </div>
  );
}

/**
 * How the merchandise receivables on this page tie to the balance sheet (A12 + A13). Plan balances include future
 * monthly charges, which become income only when collected, so they are shown apart from the receivable.
 */
export function MerchandiseReceivablesReconciliation({ category }: { category?: string | null }) {
  const { data, isLoading, error } = useMerchandiseReceivablesReconciliation();
  const { data: tie, isLoading: tieLoading, error: tieError } = useMerchandiseReceivablesBalanceSheetTie();
  const [open, setOpen] = useState(false);

  if (error) {
    return (
      <Card><CardContent className="p-4 text-sm text-destructive">Could not load the receivables reconciliation: {(error as Error).message}</CardContent></Card>
    );
  }
  const t = data?.totals;
  const bs = tie?.balance_sheet ?? null;
  const reconciled = bs ? Math.abs(bs.difference) < 1 : null;
  const issued = (data?.orders ?? []).filter((o) => o.issued);
  const catOrders = category ? issued.filter((o) => o.category === category) : [];
  const catLedger = catOrders.reduce((s, o) => s + o.ledger_receivable, 0);
  const catPlan = catOrders.reduce((s, o) => s + o.plan_balance, 0);

  const exceptions: Array<{ key: string; title: string; detail: string; amount: number }> = [];
  const add = (o: MerchReconOrder, title: string, amount: number) =>
    exceptions.push({ key: `${o.sale_id}-${title}`, title, detail: `${o.customer || 'No name'} · ${o.item_name} · ${o.account}`, amount });
  issued.forEach((o) => {
    if (o.note === 'awaiting_recognition') add(o, 'Company stock awaiting recognition', o.awaiting_recognition);
    if (o.note === 'bike_paid_differs_from_value') add(o, 'Bike: amount paid to supplier differs from the bike value', o.not_in_ledger);
    if (o.no_customer_account && o.ledger_receivable !== 0) add(o, 'No customer account on the order', o.ledger_receivable);
  });
  (data?.orphan_plans ?? []).forEach((p) => exceptions.push({
    key: p.plan_id, title: 'Plan with no order record', detail: `${p.customer || 'No name'} · ${p.item_name || 'merchandise'} · ${p.account}`, amount: p.ledger_receivable,
  }));

  return (
    <Card className="min-w-0">
      <CardHeader className="pb-2">
        <CardTitle className="flex flex-wrap items-center gap-2 text-sm font-semibold">
          <Scale className="h-4 w-4 text-primary" /> Receivables reconciliation (balance sheet A12 + A13)
          {reconciled === null ? (
            <Badge variant="secondary" className="text-[10px]">{tieError ? 'Balance sheet unavailable' : 'Checking balance sheet…'}</Badge>
          ) : reconciled ? (
            <Badge className="bg-emerald-600 text-[10px] hover:bg-emerald-600">Reconciled</Badge>
          ) : (
            <Badge variant="destructive" className="text-[10px]">Difference {formatUGX(bs!.difference)}</Badge>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {isLoading || !t ? (
          <div className="space-y-2">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-4 w-full" />)}</div>
        ) : (
          <>
            <div>
              <Line label={`Plan balances on ${t.issued_orders} issued orders (what agents still owe)`} value={t.plan_balance_issued} />
              <Line sign="-" label="Future monthly charges and other amounts not yet in the books" value={t.not_in_ledger_other} muted />
              {t.awaiting_recognition !== 0 && <Line sign="-" label="Company stock issued, awaiting recognition" value={t.awaiting_recognition} muted />}
              <Line sign="=" label="Receivable on issued orders" value={t.ledger_issued} strong />
              {t.ledger_orphan_plans !== 0 && <Line sign="+" label={`Plans with no order record (${data!.orphan_plans.length})`} value={t.ledger_orphan_plans} />}
              {t.ledger_not_issued !== 0 && <Line sign="+" label="Balances left on orders not issued" value={t.ledger_not_issued} />}
              <Line sign="=" label="Merchandise receivables" value={t.ledger_total} strong />
              <Line label="Balance sheet: A12 + A13" value={tieLoading ? null : bs?.total ?? null} muted />
              {bs && (
                <p className="text-[11px] text-muted-foreground">
                  A12 {formatUGX(bs.a12)} · A13 {formatUGX(bs.a13)} · difference {formatUGX(bs.difference)}
                </p>
              )}
            </div>

            {category && (
              <div className="rounded-lg border border-border bg-muted/40 p-2 text-xs">
                <span className="font-medium">{CATEGORY_LABEL[category] ?? category}:</span>{' '}
                receivable {formatUGX(catLedger)} on {catOrders.length} issued order{catOrders.length === 1 ? '' : 's'}
                {' '}· plan balance incl. future charges {formatUGX(catPlan)}
              </div>
            )}

            <p className="text-xs text-muted-foreground">
              Awaiting issue (not a receivable yet): {data!.awaiting_issue.count} order{data!.awaiting_issue.count === 1 ? '' : 's'},{' '}
              {formatUGX(data!.awaiting_issue.value)}
            </p>

            {exceptions.length > 0 && (
              <div>
                <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={() => setOpen((v) => !v)}>
                  {open ? <ChevronUp className="mr-1 h-3.5 w-3.5" /> : <ChevronDown className="mr-1 h-3.5 w-3.5" />}
                  Items for CFO review ({exceptions.length})
                </Button>
                {open && (
                  <ul className="mt-1 space-y-1">
                    {exceptions.map((e) => (
                      <li key={e.key} className="flex items-start justify-between gap-3 rounded-md border border-border p-2 text-xs">
                        <div className="min-w-0">
                          <p className="font-medium">{e.title}</p>
                          <p className="truncate text-muted-foreground">{e.detail}</p>
                        </div>
                        <span className="shrink-0 tabular-nums">{formatUGX(e.amount)}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
