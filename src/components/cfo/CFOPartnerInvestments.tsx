import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { StorageImage } from '@/components/ui/StorageImage';
import { formatUGX } from '@/lib/rentCalculations';
import { toast } from 'sonner';
import { format } from 'date-fns';
import {
  HandCoins, CheckCircle2, AlertTriangle, Loader2, Search,
  FileText, Eye, Download, Filter, Image as ImageIcon
} from 'lucide-react';
import { useSignedUrl } from '@/hooks/useSignedUrl';

type FilterStatus = 'all' | 'pending' | 'verified' | 'flagged';

function ReceiptLink({ filePath }: { filePath: string | null }) {
  const fullUrl = filePath ? `investment-receipts/${filePath}` : null;
  const signedUrl = useSignedUrl(fullUrl ? undefined : null);

  if (!filePath) return <span className="text-xs text-muted-foreground">No receipt</span>;

  const isImage = /\.(jpg|jpeg|png)$/i.test(filePath);

  if (isImage) {
    return (
      <StorageImage
        src={fullUrl}
        alt="Receipt"
        className="rounded-md max-h-20 object-contain cursor-pointer"
      />
    );
  }

  return (
    <Button variant="outline" size="sm" className="gap-1.5 text-xs" asChild>
      <a href="#" onClick={async (e) => {
        e.preventDefault();
        const { data } = await supabase.storage
          .from('investment-receipts')
          .createSignedUrl(filePath, 300);
        if (data?.signedUrl) window.open(data.signedUrl, '_blank');
      }}>
        <FileText className="h-3.5 w-3.5" />
        View PDF
      </a>
    </Button>
  );
}

export function CFOPartnerInvestments() {
  const queryClient = useQueryClient();
  const [filter, setFilter] = useState<FilterStatus>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [rejectDialog, setRejectDialog] = useState<{ id: string; name: string } | null>(null);
  const [rejectReason, setRejectReason] = useState('');

  const { data: investments, isLoading } = useQuery({
    queryKey: ['cfo-partner-investments', filter],
    queryFn: async () => {
      let query = supabase
        .from('investor_portfolios')
        .select(`
          id, investment_amount, investment_reference, receipt_file_url,
          cfo_verified, cfo_verified_at, cfo_rejection_reason,
          status, created_at, portfolio_code,
          investor:profiles!investor_portfolios_investor_id_fkey(full_name, phone),
          agent:profiles!investor_portfolios_agent_id_fkey(full_name)
        `)
        .not('agent_id', 'is', null)
        .order('created_at', { ascending: false })
        .limit(100);

      if (filter === 'pending') query = query.eq('cfo_verified', false).is('cfo_rejection_reason', null);
      if (filter === 'verified') query = query.eq('cfo_verified', true);
      if (filter === 'flagged') query = query.not('cfo_rejection_reason', 'is', null);

      const { data, error } = await query;
      if (error) throw error;
      return data || [];
    },
  });

  const verifyMutation = useMutation({
    mutationFn: async (portfolioId: string) => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('Not authenticated');
      const { error } = await supabase
        .from('investor_portfolios')
        .update({
          cfo_verified: true,
          cfo_verified_at: new Date().toISOString(),
          cfo_verified_by: user.id,
          cfo_rejection_reason: null,
        })
        .eq('id', portfolioId);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success('Investment verified');
      queryClient.invalidateQueries({ queryKey: ['cfo-partner-investments'] });
    },
    onError: (err: any) => toast.error(err.message),
  });

  const flagMutation = useMutation({
    mutationFn: async ({ id, reason }: { id: string; reason: string }) => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('Not authenticated');
      const { error } = await supabase
        .from('investor_portfolios')
        .update({
          cfo_verified: false,
          cfo_verified_at: new Date().toISOString(),
          cfo_verified_by: user.id,
          cfo_rejection_reason: reason,
        })
        .eq('id', id);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success('Investment flagged');
      setRejectDialog(null);
      setRejectReason('');
      queryClient.invalidateQueries({ queryKey: ['cfo-partner-investments'] });
    },
    onError: (err: any) => toast.error(err.message),
  });

  const filtered = (investments || []).filter((inv: any) => {
    if (!searchQuery.trim()) return true;
    const q = searchQuery.toLowerCase();
    return (
      inv.investor?.full_name?.toLowerCase().includes(q) ||
      inv.agent?.full_name?.toLowerCase().includes(q) ||
      inv.portfolio_code?.toLowerCase().includes(q) ||
      inv.investment_reference?.toLowerCase().includes(q)
    );
  });

  const pendingCount = (investments || []).filter((i: any) => !i.cfo_verified && !i.cfo_rejection_reason).length;

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <CardTitle className="text-base flex items-center gap-2">
              <HandCoins className="h-5 w-5 text-primary" />
              Partner Investments
              {pendingCount > 0 && (
                <Badge variant="destructive" className="text-xs">{pendingCount} pending</Badge>
              )}
            </CardTitle>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          {/* Filters */}
          <div className="flex gap-2 flex-wrap">
            {(['all', 'pending', 'verified', 'flagged'] as FilterStatus[]).map((s) => (
              <Button
                key={s}
                variant={filter === s ? 'default' : 'outline'}
                size="sm"
                className="text-xs capitalize"
                onClick={() => setFilter(s)}
              >
                {s === 'pending' && <AlertTriangle className="h-3 w-3 mr-1" />}
                {s === 'verified' && <CheckCircle2 className="h-3 w-3 mr-1" />}
                {s}
              </Button>
            ))}
          </div>

          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search partner, agent, code..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-9 h-9 text-sm"
            />
          </div>

          {isLoading ? (
            <div className="flex justify-center py-8">
              <Loader2 className="h-6 w-6 animate-spin text-primary" />
            </div>
          ) : filtered.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-6">No investments found</p>
          ) : (
            <div className="space-y-3">
              {filtered.map((inv: any) => {
                const isVerified = inv.cfo_verified;
                const isFlagged = !!inv.cfo_rejection_reason;
                const isPending = !isVerified && !isFlagged;

                return (
                  <Card key={inv.id} className="border">
                    <CardContent className="p-3 space-y-2">
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <p className="font-semibold text-sm truncate">{inv.investor?.full_name || 'Unknown'}</p>
                          <p className="text-xs text-muted-foreground">{inv.investor?.phone || '—'}</p>
                        </div>
                        <div className="text-right shrink-0">
                          <p className="font-bold text-sm">{formatUGX(inv.investment_amount)}</p>
                          {isPending && <Badge variant="outline" className="text-xs bg-orange-500/10 text-orange-600 border-orange-500/30">Pending</Badge>}
                          {isVerified && <Badge variant="outline" className="text-xs bg-green-500/10 text-green-600 border-green-500/30">Verified</Badge>}
                          {isFlagged && <Badge variant="destructive" className="text-xs">Flagged</Badge>}
                        </div>
                      </div>

                      <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
                        <div>
                          <span className="text-muted-foreground">Agent:</span>{' '}
                          <span className="font-medium">{inv.agent?.full_name || '—'}</span>
                        </div>
                        <div>
                          <span className="text-muted-foreground">Code:</span>{' '}
                          <span className="font-mono font-medium">{inv.portfolio_code || '—'}</span>
                        </div>
                        <div className="col-span-2">
                          <span className="text-muted-foreground">Reference:</span>{' '}
                          <span className="font-medium">{inv.investment_reference || 'None provided'}</span>
                        </div>
                        <div className="col-span-2">
                          <span className="text-muted-foreground">Date:</span>{' '}
                          <span>{format(new Date(inv.created_at), 'dd MMM yyyy, HH:mm')}</span>
                        </div>
                      </div>

                      {/* Receipt */}
                      <div className="pt-1">
                        <ReceiptLink filePath={inv.receipt_file_url} />
                      </div>

                      {isFlagged && inv.cfo_rejection_reason && (
                        <div className="p-2 rounded-md bg-destructive/10 text-xs text-destructive">
                          <strong>Flag reason:</strong> {inv.cfo_rejection_reason}
                        </div>
                      )}

                      {/* Actions */}
                      {(isPending || isFlagged) && (
                        <div className="flex gap-2 pt-1">
                          <Button
                            size="sm"
                            className="flex-1 text-xs gap-1"
                            onClick={() => verifyMutation.mutate(inv.id)}
                            disabled={verifyMutation.isPending}
                          >
                            <CheckCircle2 className="h-3.5 w-3.5" />
                            Verify
                          </Button>
                          {!isFlagged && (
                            <Button
                              size="sm"
                              variant="destructive"
                              className="flex-1 text-xs gap-1"
                              onClick={() => setRejectDialog({ id: inv.id, name: inv.investor?.full_name || 'Unknown' })}
                            >
                              <AlertTriangle className="h-3.5 w-3.5" />
                              Flag
                            </Button>
                          )}
                        </div>
                      )}
                    </CardContent>
                  </Card>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Flag Dialog */}
      <Dialog open={!!rejectDialog} onOpenChange={() => { setRejectDialog(null); setRejectReason(''); }}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-base">
              <AlertTriangle className="h-5 w-5 text-destructive" />
              Flag Investment
            </DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            Flag investment for <strong>{rejectDialog?.name}</strong>. Provide a reason:
          </p>
          <Textarea
            placeholder="Reason for flagging (min 10 characters)..."
            value={rejectReason}
            onChange={(e) => setRejectReason(e.target.value)}
            rows={3}
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => { setRejectDialog(null); setRejectReason(''); }}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={rejectReason.trim().length < 10 || flagMutation.isPending}
              onClick={() => rejectDialog && flagMutation.mutate({ id: rejectDialog.id, reason: rejectReason.trim() })}
            >
              {flagMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : null}
              Confirm Flag
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
