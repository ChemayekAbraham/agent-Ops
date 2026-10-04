import { useState, useMemo } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Search } from 'lucide-react';
import { formatUGX } from '@/lib/agentAdvanceCalculations';

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  advances: any[];
  onSelect: (advance: any) => void;
}

export function AdvancePaymentSearchDialog({ open, onOpenChange, advances, onSelect }: Props) {
  const [term, setTerm] = useState('');

  const results = useMemo(() => {
    const payable = advances.filter(
      (a: any) => a.status !== 'completed' && Number(a.outstanding_balance) > 0
    );
    const q = term.trim().toLowerCase();
    const list = !q
      ? payable
      : payable.filter((a: any) => {
          const name = (a.profiles?.full_name || '').toLowerCase();
          const phone = (a.profiles?.phone || '').toLowerCase();
          return name.includes(q) || phone.includes(q);
        });
    return list
      .slice()
      .sort((a: any, b: any) => Number(b.outstanding_balance) - Number(a.outstanding_balance))
      .slice(0, 50);
  }, [advances, term]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Record Agent Payment</DialogTitle>
          <DialogDescription>
            Search the agent whose advance was paid, then record the payment into the system.
          </DialogDescription>
        </DialogHeader>

        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            autoFocus
            className="pl-9"
            placeholder="Search by agent name or phone..."
            value={term}
            onChange={(e) => setTerm(e.target.value)}
          />
        </div>

        <div className="max-h-[50vh] overflow-y-auto space-y-2 pr-1">
          {results.length === 0 && (
            <p className="text-sm text-muted-foreground py-6 text-center">
              No outstanding advance matches that search.
            </p>
          )}
          {results.map((a: any) => (
            <button
              key={a.id}
              type="button"
              onClick={() => {
                onSelect(a);
                onOpenChange(false);
                setTerm('');
              }}
              className="w-full text-left rounded-lg border border-border/60 p-3 hover:bg-muted/60 transition-colors"
            >
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-sm font-semibold truncate">
                    {a.profiles?.full_name || 'Unknown agent'}
                  </p>
                  <p className="text-xs text-muted-foreground truncate">
                    {a.profiles?.phone || 'No phone'} · Principal {formatUGX(Number(a.principal))}
                  </p>
                </div>
                <div className="text-right shrink-0">
                  <p className="text-sm font-bold">{formatUGX(Number(a.outstanding_balance))}</p>
                  <Badge variant={a.status === 'overdue' ? 'destructive' : 'secondary'} className="text-[10px] mt-1">
                    {a.status}
                  </Badge>
                </div>
              </div>
            </button>
          ))}
        </div>

        <div className="flex justify-end">
          <Button variant="outline" onClick={() => onOpenChange(false)}>Close</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
