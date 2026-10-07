import { Badge } from '@/components/ui/badge';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

export type FulfilmentType = 'company_issued' | 'outsourced';

export const FULFILMENT_LABEL: Record<FulfilmentType, string> = {
  company_issued: 'Company issued',
  outsourced: 'Out-sourced',
};

export const FULFILMENT_HINT: Record<FulfilmentType, string> = {
  company_issued: 'After approval the agent collects it from a company handler. Repayment starts once the handover is confirmed.',
  outsourced: 'After approval the CFO sends the money to the agent\'s wallet. Repayment starts automatically.',
};

export function FulfilmentBadge({ type }: { type?: string | null }) {
  if (type !== 'company_issued' && type !== 'outsourced') {
    return <span className="text-xs text-muted-foreground">—</span>;
  }
  return (
    <Badge variant={type === 'company_issued' ? 'secondary' : 'outline'} className="text-[10px]">
      {FULFILMENT_LABEL[type]}
    </Badge>
  );
}

export function FulfilmentTypeSelect({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <div className="space-y-1.5">
      <Label>Category</Label>
      <Select value={value || 'none'} onValueChange={(v) => onChange(v === 'none' ? '' : v)}>
        <SelectTrigger><SelectValue placeholder="Pick a category" /></SelectTrigger>
        <SelectContent>
          <SelectItem value="company_issued">Company issued</SelectItem>
          <SelectItem value="outsourced">Out-sourced</SelectItem>
          <SelectItem value="none">No category (current flow)</SelectItem>
        </SelectContent>
      </Select>
      {(value === 'company_issued' || value === 'outsourced') && (
        <p className="text-[11px] text-muted-foreground">{FULFILMENT_HINT[value]}</p>
      )}
    </div>
  );
}
