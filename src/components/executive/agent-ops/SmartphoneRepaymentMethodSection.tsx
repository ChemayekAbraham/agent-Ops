import { useEffect, useState } from 'react';
import { Loader2, Wallet, TrendingUp, Check } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { formatUGX } from '@/lib/rentCalculations';
import {
  useSmartphoneRepaymentMethods,
  useSetSmartphoneRepaymentMethods,
  type ReturnsDeductionMode,
} from '@/hooks/useSmartphoneRepaymentMethods';

interface Props {
  agentId: string;
  /** Monthly Returns across active portfolios, for the deduction preview. */
  monthlyReturns?: number;
}

/** Agent Ops picks how an agent repays their smartphone: commission (daily, from wallet) and/or partnership Returns. */
export function SmartphoneRepaymentMethodSection({ agentId, monthlyReturns = 0 }: Props) {
  const { data, isLoading, error } = useSmartphoneRepaymentMethods(agentId);
  const save = useSetSmartphoneRepaymentMethods(agentId);

  const [useCommission, setUseCommission] = useState(false);
  const [useReturns, setUseReturns] = useState(false);
  const [mode, setMode] = useState<ReturnsDeductionMode>('percent');
  const [value, setValue] = useState('');

  useEffect(() => {
    if (!data) return;
    setUseCommission(data.commission_enabled);
    setUseReturns(data.returns_enabled);
    setMode(data.returns_mode ?? 'percent');
    setValue(data.returns_value != null ? String(data.returns_value) : '');
  }, [data]);

  if (isLoading) {
    return (
      <div className="rounded-xl border border-border p-3 flex justify-center">
        <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
      </div>
    );
  }
  if (error || !data || data.active_plans === 0) return null;

  const num = Number(value);
  const valueValid = Number.isFinite(num) && num > 0 && (mode === 'amount' || num <= 100);
  const dirty =
    useCommission !== data.commission_enabled ||
    useReturns !== data.returns_enabled ||
    (useReturns && (mode !== data.returns_mode || num !== Number(data.returns_value)));
  const canSave = data.can_edit && dirty && (!useReturns || valueValid) && !save.isPending;

  const preview =
    useReturns && valueValid && monthlyReturns > 0
      ? mode === 'percent'
        ? Math.floor((monthlyReturns * num) / 100)
        : Math.min(num, monthlyReturns)
      : null;

  const methods = [
    {
      key: 'commission',
      on: useCommission,
      toggle: () => setUseCommission((v) => !v),
      icon: Wallet,
      label: 'Agent commission',
      hint: 'Daily instalment taken from the agent wallet',
    },
    {
      key: 'returns',
      on: useReturns,
      toggle: () => setUseReturns((v) => !v),
      icon: TrendingUp,
      label: 'Partnership Returns',
      hint: 'Deducted when Returns are paid',
    },
  ];

  return (
    <section className="rounded-xl border border-border p-3 space-y-3" aria-label="Repayment method">
      <div className="flex items-center justify-between gap-2">
        <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">Repayment method</p>
        {!data.can_edit && <Badge variant="outline" className="text-[10px]">View only</Badge>}
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        {methods.map((m) => {
          const Icon = m.icon;
          return (
            <button
              key={m.key}
              type="button"
              aria-pressed={m.on}
              disabled={!data.can_edit}
              onClick={m.toggle}
              className={cn(
                'flex items-start gap-2 rounded-lg border p-2.5 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-70',
                m.on ? 'border-primary bg-primary/5' : 'border-border hover:bg-muted/50',
              )}
            >
              <Icon className={cn('h-4 w-4 mt-0.5 shrink-0', m.on ? 'text-primary' : 'text-muted-foreground')} />
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-semibold">{m.label}</span>
                <span className="block text-[11px] text-muted-foreground">{m.hint}</span>
              </span>
              {m.on && <Check className="h-4 w-4 text-primary shrink-0" />}
            </button>
          );
        })}
      </div>

      {useReturns && (
        <div className="space-y-2 rounded-lg bg-muted/40 p-2.5">
          <p className="text-xs font-medium">Deduct from each Returns payment</p>
          <div className="flex flex-wrap items-center gap-2">
            <div className="inline-flex rounded-md border border-border p-0.5">
              {(['percent', 'amount'] as const).map((m) => (
                <Button
                  key={m}
                  type="button"
                  size="sm"
                  variant={mode === m ? 'default' : 'ghost'}
                  className="h-7 px-3 text-xs"
                  disabled={!data.can_edit}
                  onClick={() => setMode(m)}
                >
                  {m === 'percent' ? 'Percentage' : 'Fixed amount'}
                </Button>
              ))}
            </div>
            <div className="relative w-40">
              <Input
                type="number"
                inputMode="numeric"
                min={1}
                max={mode === 'percent' ? 100 : undefined}
                value={value}
                disabled={!data.can_edit}
                onChange={(e) => setValue(e.target.value)}
                className="h-8 pr-10 text-sm"
                placeholder={mode === 'percent' ? 'e.g. 50' : 'e.g. 100000'}
              />
              <span className="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">
                {mode === 'percent' ? '%' : 'UGX'}
              </span>
            </div>
          </div>
          {value !== '' && !valueValid && (
            <p className="text-[11px] text-destructive">
              {mode === 'percent' ? 'Enter a percentage between 1 and 100.' : 'Enter an amount above 0.'}
            </p>
          )}
          {preview != null && (
            <p className="text-[11px] text-muted-foreground">
              About <span className="font-semibold text-foreground">{formatUGX(preview)}</span> of{' '}
              {formatUGX(Math.round(monthlyReturns))} monthly Returns.
            </p>
          )}
          {data.active_portfolios === 0 && (
            <p className="text-[11px] text-amber-600">
              This agent has no active portfolio, so nothing is deducted until Returns are paid.
            </p>
          )}
        </div>
      )}

      {!useCommission && !useReturns && (
        <p className="text-[11px] text-amber-600">
          With neither method selected, nothing is collected for this phone.
        </p>
      )}

      {data.can_edit && (
        <div className="flex justify-end">
          <Button
            size="sm"
            disabled={!canSave}
            onClick={() =>
              save.mutate({ useCommission, useReturns, returnsMode: mode, returnsValue: num })
            }
          >
            {save.isPending && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
            Save repayment method
          </Button>
        </div>
      )}
    </section>
  );
}
