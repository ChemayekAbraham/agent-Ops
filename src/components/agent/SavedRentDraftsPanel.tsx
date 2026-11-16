import { useEffect, useState, useCallback } from 'react';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { formatUGX } from '@/lib/rentCalculations';
import { Loader2, Send, Trash2, FileClock, CheckCircle2 } from 'lucide-react';
import { toast } from 'sonner';

interface DraftRow {
  id: string;
  tenant_name: string;
  tenant_phone: string;
  rent_amount: number;
  payload: Record<string, any>;
  status: 'pending' | 'submitted' | 'cancelled';
  created_at: string;
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onPushDraft: (draft: { id: string; payload: Record<string, any> }) => void;
}

export default function SavedRentDraftsPanel({ open, onOpenChange, onPushDraft }: Props) {
  const { user } = useAuth();
  // E63: no rent cap per tenant, so every saved draft can be pushed.

  const [drafts, setDrafts] = useState<DraftRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!user) return;
    setLoading(true);
    const { data, error } = await supabase
      .from('rent_request_drafts' as any)
      .select('id,tenant_name,tenant_phone,rent_amount,payload,status,created_at')
      .eq('agent_id', user.id)
      .eq('status', 'pending')
      .order('created_at', { ascending: false });
    setLoading(false);
    if (error) { toast.error(error.message); return; }
    setDrafts((data as any) || []);
  }, [user]);

  useEffect(() => { if (open) load(); }, [open, load]);

  const handleDelete = async (id: string) => {
    setBusyId(id);
    const { error } = await supabase
      .from('rent_request_drafts' as any)
      .update({ status: 'cancelled' })
      .eq('id', id);
    setBusyId(null);
    if (error) { toast.error(error.message); return; }
    toast.success('Draft removed');
    setDrafts(prev => prev.filter(d => d.id !== id));
  };

  const handlePush = (draft: DraftRow) => {
    onOpenChange(false);
    onPushDraft({ id: draft.id, payload: draft.payload });
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="bottom" className="max-h-[88vh] overflow-y-auto">
        <SheetHeader className="text-left">
          <SheetTitle className="flex items-center gap-2">
            <FileClock className="h-5 w-5 text-primary" />
            Saved Rent Drafts
          </SheetTitle>
          <SheetDescription>
            Rent requests you saved to finish later. Push one back into the form to send it.
          </SheetDescription>
        </SheetHeader>

        <div className="mt-4 space-y-3">
          {loading ? (
            <div className="flex items-center justify-center py-8 text-muted-foreground">
              <Loader2 className="h-5 w-5 animate-spin mr-2" /> Loading…
            </div>
          ) : drafts.length === 0 ? (
            <div className="text-center py-8 text-sm text-muted-foreground">
              No saved drafts.
            </div>
          ) : (
            drafts.map(d => {
              return (
                <div key={d.id} className="rounded-xl border p-3 space-y-2 bg-card">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="font-semibold truncate">{d.tenant_name}</div>
                      <div className="text-xs text-muted-foreground font-mono">{d.tenant_phone}</div>
                    </div>
                    <Badge className="bg-emerald-600 text-white"><CheckCircle2 className="h-3 w-3 mr-1" />Ready</Badge>
                  </div>
                  <div className="text-sm">
                    Rent: <span className="font-mono font-semibold">{formatUGX(Number(d.rent_amount))}</span>
                  </div>
                  <div className="flex gap-2 pt-1">
                    <Button
                      size="sm"
                      className="flex-1"
                      disabled={busyId === d.id}
                      onClick={() => handlePush(d)}
                    >
                      <Send className="h-4 w-4 mr-1" /> Push now
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busyId === d.id}
                      onClick={() => handleDelete(d.id)}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}