import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Badge } from '@/components/ui/badge';
import { formatUGX } from '@/lib/rentCalculations';
import { FileText, TrendingUp, Users, Phone, Mail, Calendar, ChevronRight, Loader2, Wallet } from 'lucide-react';
import { cn } from '@/lib/utils';

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}

const statusConfig: Record<string, { label: string; class: string }> = {
  pending: { label: 'Pending', class: 'bg-amber-100 text-amber-800 border-amber-300' },
  activated: { label: 'Activated', class: 'bg-emerald-100 text-emerald-800 border-emerald-300' },
  fulfilled: { label: 'Fulfilled', class: 'bg-blue-100 text-blue-800 border-blue-300' },
  cancelled: { label: 'Cancelled', class: 'bg-muted text-muted-foreground border-border' },
};

export function AgentPromissoryNotesList({ open, onOpenChange }: Props) {
  const [selected, setSelected] = useState<any>(null);

  const { data: notes, isLoading } = useQuery({
    queryKey: ['agent-promissory-notes'],
    queryFn: async () => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return [];
      const { data, error } = await supabase
        .from('promissory_notes')
        .select('*')
        .eq('agent_id', user.id)
        .order('created_at', { ascending: false });
      if (error) throw error;
      return data || [];
    },
    enabled: open,
  });

  const totalPromised = notes?.reduce((s, n) => s + (n.amount || 0), 0) ?? 0;
  const totalCollected = notes?.reduce((s, n) => s + (n.total_collected || 0), 0) ?? 0;
  const myCommission = totalPromised * 0.02;
  const earnedCommission = totalCollected * 0.02;
  

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="bottom" className="h-[92vh] rounded-t-2xl p-0 overflow-hidden">
        <SheetHeader className="px-4 pt-4 pb-2">
          <SheetTitle className="flex items-center gap-2 text-base">
            <FileText className="h-5 w-5 text-primary" />
            My Promissory Notes
          </SheetTitle>
        </SheetHeader>

        {/* Summary cards */}
        <div className="grid grid-cols-2 gap-2 px-4 pb-2">
          <div className="rounded-xl bg-primary/10 p-2.5 text-center">
            <Users className="h-4 w-4 mx-auto text-primary mb-1" />
            <div className="text-lg font-bold text-primary">{notes?.length ?? 0}</div>
            <div className="text-[10px] text-muted-foreground">Partners Registered</div>
          </div>
          <div className="rounded-xl bg-emerald-50 p-2.5 text-center">
            <TrendingUp className="h-4 w-4 mx-auto text-emerald-600 mb-1" />
            <div className="text-sm font-bold text-emerald-700">{formatUGX(totalPromised)}</div>
            <div className="text-[10px] text-muted-foreground">Total Promised</div>
          </div>
        </div>

        {/* Commission highlight */}
        <div className="mx-4 mb-3 rounded-xl bg-gradient-to-r from-primary/10 to-primary/5 border border-primary/20 p-3">
          <div className="flex items-center gap-2 mb-1">
            <Wallet className="h-4 w-4 text-primary" />
            <span className="text-xs font-semibold text-primary">Your 2% Commission</span>
          </div>
          <div className="flex justify-between text-sm">
            <div>
              <div className="font-bold text-primary">{formatUGX(myCommission)}</div>
              <div className="text-[10px] text-muted-foreground">Potential (if all fulfilled)</div>
            </div>
            <div className="text-right">
              <div className="font-bold text-emerald-600">{formatUGX(earnedCommission)}</div>
              <div className="text-[10px] text-muted-foreground">Earned so far</div>
            </div>
          </div>
        </div>

        {/* List */}
        <div className="flex-1 overflow-y-auto px-4 pb-6 space-y-2" style={{ maxHeight: 'calc(92vh - 220px)' }}>
          {isLoading ? (
            <div className="flex justify-center py-12"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>
          ) : !notes?.length ? (
            <div className="text-center py-12 text-muted-foreground text-sm">
              No promissory notes yet. Create one from the menu.
            </div>
          ) : (
            notes.map((note) => {
              const cfg = statusConfig[note.status] ?? statusConfig.pending;
              const noteCommission = note.amount * 0.02;
              const isExpanded = selected?.id === note.id;

              return (
                <div
                  key={note.id}
                  className="rounded-xl border bg-card p-3 space-y-2 cursor-pointer transition-all hover:shadow-sm"
                  onClick={() => setSelected(isExpanded ? null : note)}
                >
                  <div className="flex items-center justify-between">
                    <div className="flex-1 min-w-0">
                      <div className="font-semibold text-sm truncate">{note.partner_name}</div>
                      <div className="text-xs text-muted-foreground">
                        {note.contribution_type === 'monthly' ? 'Monthly' : 'Once-off'} · {formatUGX(note.amount)}
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <Badge variant="outline" className={cn('text-[10px] px-1.5 py-0.5', cfg.class)}>
                        {cfg.label}
                      </Badge>
                      <ChevronRight className={cn('h-4 w-4 text-muted-foreground transition-transform', isExpanded && 'rotate-90')} />
                    </div>
                  </div>

                  {/* Commission preview line */}
                  <div className="text-[11px] text-primary font-medium">
                    💰 You earn {formatUGX(noteCommission)} commission (2%)
                  </div>

                  {isExpanded && (
                    <div className="pt-2 border-t space-y-2 text-xs">
                      {/* Earnings breakdown */}
                      <div className="rounded-lg bg-primary/5 p-2.5 space-y-1">
                        <div className="font-semibold text-primary text-xs">🤑 Your Commission Breakdown</div>
                        <div className="flex justify-between">
                          <span className="text-muted-foreground">Funding promised</span>
                          <span className="font-medium">{formatUGX(note.amount)}</span>
                        </div>
                        <div className="flex justify-between">
                          <span className="text-muted-foreground">Your 2% commission</span>
                          <span className="font-bold text-primary">{formatUGX(noteCommission)}</span>
                        </div>
                        <div className="flex justify-between">
                          <span className="text-muted-foreground">Collected so far</span>
                          <span className="font-medium">{formatUGX(note.total_collected)}</span>
                        </div>
                        <div className="flex justify-between">
                          <span className="text-muted-foreground">Commission earned</span>
                          <span className="font-bold text-emerald-600">{formatUGX(note.total_collected * 0.02)}</span>
                        </div>
                      </div>

                      {/* Partner ROI info */}
                      <div className="rounded-lg bg-emerald-50 p-2.5 space-y-1">
                        <div className="font-semibold text-emerald-800 text-xs">💰 Partner Earns</div>
                        <div className="flex justify-between">
                          <span className="text-muted-foreground">Monthly ROI (15%)</span>
                          <span className="font-bold text-emerald-700">{formatUGX(note.amount * 0.15)}</span>
                        </div>
                        <div className="flex justify-between">
                          <span className="text-muted-foreground">Annual ROI</span>
                          <span className="font-bold text-emerald-700">{formatUGX(note.amount * 0.15 * 12)}</span>
                        </div>
                      </div>

                      {/* Contact info */}
                      <div className="flex flex-wrap gap-3 text-muted-foreground">
                        {note.whatsapp_number && (
                          <a href={`https://wa.me/${note.whatsapp_number.replace(/\D/g, '')}`} className="flex items-center gap-1 hover:text-emerald-600" onClick={e => e.stopPropagation()}>
                            <Phone className="h-3 w-3" /> WhatsApp
                          </a>
                        )}
                        {note.phone_number && (
                          <a href={`tel:${note.phone_number}`} className="flex items-center gap-1 hover:text-primary" onClick={e => e.stopPropagation()}>
                            <Phone className="h-3 w-3" /> Call
                          </a>
                        )}
                        {note.email && (
                          <a href={`mailto:${note.email}`} className="flex items-center gap-1 hover:text-primary" onClick={e => e.stopPropagation()}>
                            <Mail className="h-3 w-3" /> Email
                          </a>
                        )}
                      </div>

                      {note.deduction_day && (
                        <div className="flex items-center gap-1 text-muted-foreground">
                          <Calendar className="h-3 w-3" />
                          Deduction day: {note.deduction_day} of each month
                        </div>
                      )}

                      <div className="text-[10px] text-muted-foreground">
                        Created {new Date(note.created_at).toLocaleDateString()}
                      </div>
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
