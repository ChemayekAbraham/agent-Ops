import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from '@/components/ui/sheet';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Phone, MessageCircle } from 'lucide-react';
import { usePartnerCapitalProjections, type Horizon } from './PartnerPortfolioProjections';

export type ForwardStream = 'roi' | 'compounding' | 'notes';

const fmtUGX = (n: number) => `UGX ${Math.round(Number(n) || 0).toLocaleString()}`;

const digits = (p?: string | null) => (p || '').replace(/[^\d]/g, '');
const intl = (p?: string | null) => {
  const d = digits(p);
  if (!d) return '';
  if (d.startsWith('256')) return d;
  if (d.startsWith('0')) return `256${d.slice(1)}`;
  return d;
};

function ContactButtons({ phone, whatsapp, size = 'sm' }: { phone?: string | null; whatsapp?: string | null; size?: 'sm' | 'lg' }) {
  const call = digits(phone) || digits(whatsapp);
  const wa = intl(whatsapp || phone);
  if (!call && !wa) return <span className="text-[10px] text-muted-foreground">No number</span>;
  if (size === 'lg') {
    return (
      <div className="grid grid-cols-2 gap-2">
        {call ? (
          <Button asChild variant="outline" className="h-11 justify-center text-xs font-semibold">
            <a href={`tel:${call}`}><Phone className="h-4 w-4 mr-1.5" />Call</a>
          </Button>
        ) : <span />}
        {wa ? (
          <Button asChild variant="outline" className="h-11 justify-center text-xs font-semibold text-green-600 border-green-300">
            <a href={`https://wa.me/${wa}`} target="_blank" rel="noreferrer"><MessageCircle className="h-4 w-4 mr-1.5" />WhatsApp</a>
          </Button>
        ) : <span />}
      </div>
    );
  }
  return (
    <div className="flex items-center gap-1">
      {call && (
        <Button asChild size="sm" variant="outline" className="h-7 px-2 text-[10px]">
          <a href={`tel:${call}`}><Phone className="h-3 w-3 mr-1" />{call}</a>
        </Button>
      )}
      {wa && (
        <Button asChild size="sm" variant="outline" className="h-7 px-2 text-[10px] text-green-600 border-green-300">
          <a href={`https://wa.me/${wa}`} target="_blank" rel="noreferrer"><MessageCircle className="h-3 w-3" /></a>
        </Button>
      )}
    </div>
  );
}

function useNotesBreakdown(enabled: boolean) {
  return useQuery({
    queryKey: ['forward-notes-breakdown'],
    enabled,
    staleTime: 300000,
    queryFn: async () => {
      const { data: notes, error } = await supabase
        .from('promissory_notes')
        .select('id, partner_name, phone_number, whatsapp_number, amount, total_collected, status, next_deduction_date, deduction_day, agent_id, created_at')
        .in('status', ['activated', 'pending', 'approved'])
        .limit(2000);
      if (error) throw error;
      const agentIds = Array.from(new Set((notes || []).map(n => n.agent_id).filter(Boolean))) as string[];
      let agents: Record<string, { name: string; phone: string | null }> = {};
      if (agentIds.length) {
        const { data: profiles } = await supabase
          .from('profiles')
          .select('id, full_name, phone')
          .in('id', agentIds);
        agents = Object.fromEntries((profiles || []).map(p => [p.id, { name: p.full_name || 'Unknown agent', phone: p.phone }]));
      }
      return (notes || [])
        .map(n => ({
          ...n,
          outstanding: Math.max(0, Number(n.amount || 0) - Number(n.total_collected || 0)),
          agent_name: n.agent_id ? agents[n.agent_id]?.name || 'Unknown agent' : 'No agent recorded',
          agent_phone: n.agent_id ? agents[n.agent_id]?.phone || null : null,
        }))
        .sort((a, b) => b.outstanding - a.outstanding);
    },
  });
}

export function ForwardBreakdownSheet({
  stream,
  horizon,
  onOpenChange,
}: {
  stream: ForwardStream | null;
  horizon: Horizon;
  onOpenChange: (open: boolean) => void;
}) {
  const open = !!stream;
  const [q, setQ] = useState('');
  const [noteFilter, setNoteFilter] = useState<'all' | 'due' | 'unscheduled' | 'callable'>('all');
  const { data: proj, isLoading: projLoading } = usePartnerCapitalProjections(horizon);
  const { data: notes, isLoading: notesLoading } = useNotesBreakdown(stream === 'notes');

  const partnerRows = useMemo(() => {
    const list = (proj?.partners || []).map(p => ({
      ...p,
      value: stream === 'compounding' ? Number(p.projected_compound_growth || 0) : Number(p.projected_monthly_payout || 0),
    }));
    const needle = q.trim().toLowerCase();
    return list
      .filter(p => p.value > 0)
      .filter(p => !needle || `${p.partner_name} ${p.phone || ''}`.toLowerCase().includes(needle))
      .sort((a, b) => b.value - a.value);
  }, [proj, stream, q]);

  const noteRows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const today = new Date().toISOString().slice(0, 10);
    const weekAhead = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);
    return (notes || [])
      .filter(n => !needle || `${n.partner_name || ''} ${n.phone_number || ''} ${n.whatsapp_number || ''} ${n.agent_name}`.toLowerCase().includes(needle))
      .filter(n => {
        if (noteFilter === 'due') return !!n.next_deduction_date && n.next_deduction_date <= weekAhead;
        if (noteFilter === 'unscheduled') return !n.next_deduction_date;
        if (noteFilter === 'callable') return !!(digits(n.phone_number) || digits(n.whatsapp_number));
        return true;
      })
      .map(n => ({ ...n, overdue: !!n.next_deduction_date && n.next_deduction_date < today }));
  }, [notes, q, noteFilter]);

  const title =
    stream === 'notes' ? 'Notes receivable — who owes what' :
    stream === 'compounding' ? 'Projected compounding — by partner' :
    'Projected ROI payout — by partner';

  const total = stream === 'notes'
    ? noteRows.reduce((s, n) => s + n.outstanding, 0)
    : partnerRows.reduce((s, p) => s + p.value, 0);

  const loading = stream === 'notes' ? notesLoading : projLoading;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full sm:max-w-xl p-0 flex flex-col">
        <SheetHeader className="p-4 pb-2">
          <SheetTitle className="text-sm">{title}</SheetTitle>
          <SheetDescription className="text-xs">
            {stream === 'notes'
              ? 'Outstanding promissory commitments, the partner behind each note and the agent who recorded it.'
              : `Horizon: ${horizon.label || `${horizon.days} days`}. Tap a number to call or WhatsApp the partner.`}
          </SheetDescription>
        </SheetHeader>

        <div className="sticky top-0 z-10 bg-background border-b px-4 pb-2 space-y-2">
          <div className="flex items-center gap-2">
            <Input
              value={q}
              onChange={e => setQ(e.target.value)}
              inputMode="search"
              placeholder="Search name, phone or agent…"
              className="h-10 text-sm"
            />
            <Badge variant="outline" className="text-[9px] whitespace-nowrap">
              {stream === 'notes' ? noteRows.length : partnerRows.length} · {fmtUGX(total)}
            </Badge>
          </div>
          {stream === 'notes' && (
            <div className="flex gap-1.5 overflow-x-auto pb-0.5 -mx-1 px-1">
              {([
                ['all', 'All'],
                ['due', 'Due ≤ 7 days'],
                ['unscheduled', 'Unscheduled'],
                ['callable', 'Has number'],
              ] as const).map(([key, label]) => (
                <Button
                  key={key}
                  size="sm"
                  variant={noteFilter === key ? 'default' : 'outline'}
                  className="h-8 px-3 text-[11px] rounded-full shrink-0"
                  onClick={() => setNoteFilter(key)}
                >
                  {label}
                </Button>
              ))}
            </div>
          )}
        </div>

        <ScrollArea className="flex-1 px-4 pb-6">
          {loading ? (
            <div className="h-40 rounded-lg bg-muted/40 animate-pulse" />
          ) : stream === 'notes' ? (
            <div className="space-y-2">
              {noteRows.map(n => (
                <div key={n.id} className="rounded-xl border p-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-sm font-semibold truncate">{n.partner_name || 'Unnamed partner'}</p>
                      <p className="text-[11px] text-muted-foreground truncate">
                        {digits(n.phone_number) || digits(n.whatsapp_number) || 'No number on file'}
                      </p>
                      <p className="text-[10px] text-muted-foreground mt-0.5">
                        Recorded by {n.agent_name}
                        {n.deduction_day ? ` · day ${n.deduction_day}` : ''}
                      </p>
                    </div>
                    <div className="text-right shrink-0">
                      <p className="text-sm font-bold text-amber-600">{fmtUGX(n.outstanding)}</p>
                      <p className="text-[9px] text-muted-foreground">of {fmtUGX(Number(n.amount || 0))}</p>
                      <Badge variant={n.overdue ? 'destructive' : 'outline'} className="text-[9px] mt-0.5">
                        {n.next_deduction_date ? (n.overdue ? `overdue ${n.next_deduction_date}` : `next ${n.next_deduction_date}`) : 'unscheduled'}
                      </Badge>
                    </div>
                  </div>
                  <div className="mt-2.5">
                    <ContactButtons phone={n.phone_number} whatsapp={n.whatsapp_number} size="lg" />
                  </div>
                  {n.agent_phone && (
                    <a
                      href={`tel:${digits(n.agent_phone)}`}
                      className="mt-2 flex h-9 items-center justify-center rounded-lg bg-muted/60 text-[11px] font-medium text-primary"
                    >
                      <Phone className="h-3.5 w-3.5 mr-1.5" />Call agent {n.agent_name}
                    </a>
                  )}
                </div>
              ))}
              {noteRows.length === 0 && <p className="text-xs text-muted-foreground p-4 text-center">No notes match.</p>}
            </div>
          ) : (
            <div className="space-y-2">
              {partnerRows.map(p => (
                <div key={p.partner_id} className="rounded-lg border p-2.5">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="text-xs font-medium truncate">{p.partner_name}</p>
                      <p className="text-[10px] text-muted-foreground">
                        {p.portfolios} plan{p.portfolios === 1 ? '' : 's'} · {p.top_rate}% · deployed {fmtUGX(Number(p.deployed))}
                        {p.next_roi_date ? ` · next ${p.next_roi_date}` : ''}
                      </p>
                    </div>
                    <div className="text-right shrink-0">
                      <p className={`text-xs font-bold ${stream === 'compounding' ? 'text-violet-600' : 'text-blue-600'}`}>{fmtUGX(p.value)}</p>
                      <p className="text-[9px] text-muted-foreground">{stream === 'compounding' ? 'compounding' : 'per month'}</p>
                    </div>
                  </div>
                  <div className="mt-2">
                    <ContactButtons phone={p.phone} whatsapp={p.phone} />
                  </div>
                </div>
              ))}
              {partnerRows.length === 0 && <p className="text-xs text-muted-foreground p-4 text-center">No partners match.</p>}
            </div>
          )}
        </ScrollArea>
      </SheetContent>
    </Sheet>
  );
}