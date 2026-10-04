import { useCallback, useEffect, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Textarea } from '@/components/ui/textarea';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Ban, ShieldCheck, Loader2, AlertTriangle } from 'lucide-react';
import { toast } from 'sonner';

interface AgentListingBlockControlProps {
  agentId: string;
  agentName?: string | null;
  /**
   * Optional preloaded posting status. When provided, the control skips its own
   * per-mount fetch (avoids N+1 when rendered inside a large list). Pass `null`
   * for "known: no block, zero rejections". Pass `undefined` (default) to let
   * the control fetch its own status on mount.
   */
  preloadedStatus?: { block: ActiveBlock | null; recentRejections: number } | null;
}

interface ActiveBlock {
  id: string;
  blocked_until: string;
  reason: string;
  auto_blocked: boolean;
  rejection_count: number | null;
}

/**
 * Landlord Ops control to block / unblock a specific agent from posting houses.
 *
 * - Agents are auto-blocked for 2 days after 3 listing rejections (DB side).
 * - Ops can also manually block (min 10-char reason, default 2 days) or unblock.
 * - While blocked the agent earns no listing rewards or commission (DB enforced
 *   via the insert trigger that rejects new listings).
 */
export function AgentListingBlockControl({ agentId, agentName, preloadedStatus }: AgentListingBlockControlProps) {
  const hasPreload = preloadedStatus !== undefined;
  const [block, setBlock] = useState<ActiveBlock | null>(preloadedStatus?.block ?? null);
  const [recentRejections, setRecentRejections] = useState<number>(preloadedStatus?.recentRejections ?? 0);
  const [loading, setLoading] = useState(!hasPreload);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [mode, setMode] = useState<'block' | 'unblock'>('block');
  const [reason, setReason] = useState('');
  const [days, setDays] = useState('2');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (!agentId) return;
    setLoading(true);
    try {
      const { data: blockRow } = await supabase
        .from('agent_listing_blocks')
        .select('id, blocked_until, reason, auto_blocked, rejection_count, created_at')
        .eq('agent_id', agentId)
        .eq('active', true)
        .gt('blocked_until', new Date().toISOString())
        .order('blocked_until', { ascending: false })
        .limit(1)
        .maybeSingle();

      const active = (blockRow as ActiveBlock | null) ?? null;
      setBlock(active);

      // Count rejections accumulated since the agent's most recent block (the
      // 3-strike window). Helps Ops decide whether a manual block is warranted.
      const { data: lastBlock } = await supabase
        .from('agent_listing_blocks')
        .select('created_at')
        .eq('agent_id', agentId)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      let rejQuery = supabase
        .from('agent_listing_rejections')
        .select('id', { count: 'exact', head: true })
        .eq('agent_id', agentId);
      if ((lastBlock as any)?.created_at) {
        rejQuery = rejQuery.gt('rejected_at', (lastBlock as any).created_at);
      }
      const { count } = await rejQuery;
      setRecentRejections(count ?? 0);
    } catch {
      /* best-effort */
    } finally {
      setLoading(false);
    }
  }, [agentId]);

  useEffect(() => {
    // If the parent preloaded status (batched query pattern), just sync into
    // local state and skip the per-mount fetch. This is the fast path for
    // list-heavy screens like the Verification Queue.
    if (hasPreload) {
      setBlock(preloadedStatus?.block ?? null);
      setRecentRejections(preloadedStatus?.recentRejections ?? 0);
      setLoading(false);
      return;
    }
    load();
  }, [load, hasPreload, preloadedStatus]);

  const openBlock = () => { setMode('block'); setReason(''); setDays('2'); setDialogOpen(true); };
  const openUnblock = () => { setMode('unblock'); setReason(''); setDialogOpen(true); };

  const submit = async () => {
    if (mode === 'block' && reason.trim().length < 10) {
      toast.error('Reason must be at least 10 characters', {
        description: 'The agent will read this, so explain clearly why posting is blocked.',
      });
      return;
    }
    setBusy(true);
    try {
      if (mode === 'block') {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const { error } = await (supabase as any).rpc('block_agent_listing', {
          p_agent_id: agentId,
          p_reason: reason.trim(),
          p_days: Math.max(1, Number(days) || 2),
        });
        if (error) throw error;
        toast.success('Agent blocked from posting houses');
      } else {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const { error } = await (supabase as any).rpc('unblock_agent_listing', {
          p_agent_id: agentId,
          p_reason: reason.trim() || null,
        });
        if (error) throw error;
        toast.success('Agent unblocked — they can post houses again');
      }
      setDialogOpen(false);
      await load();
    } catch (err: any) {
      toast.error(err?.message || 'Action failed');
    } finally {
      setBusy(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
        <Loader2 className="h-3 w-3 animate-spin" /> Checking posting status…
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-1.5 flex-wrap">
          {block ? (
            <Badge className="bg-destructive/10 text-destructive border-0 text-[10px] h-5 px-1.5 font-bold">
              <Ban className="h-3 w-3 mr-0.5" />
              Blocked until {new Date(block.blocked_until).toLocaleDateString()}
            </Badge>
          ) : (
            <Badge className="bg-emerald-100 text-emerald-700 border-0 text-[10px] h-5 px-1.5 font-bold">
              <ShieldCheck className="h-3 w-3 mr-0.5" /> Can post
            </Badge>
          )}
          {!block && recentRejections > 0 && (
            <Badge
              className={`border-0 text-[10px] h-5 px-1.5 font-bold ${recentRejections >= 2 ? 'bg-amber-100 text-amber-700' : 'bg-muted text-muted-foreground'}`}
            >
              <AlertTriangle className="h-3 w-3 mr-0.5" />
              {recentRejections} rejection{recentRejections === 1 ? '' : 's'}{recentRejections >= 2 ? ' — 1 more = auto-block' : ''}
            </Badge>
          )}
        </div>
        {block ? (
          <Button size="sm" variant="outline" className="h-7 px-2 text-[11px] gap-1" onClick={openUnblock}>
            <ShieldCheck className="h-3 w-3" /> Unblock
          </Button>
        ) : (
          <Button
            size="sm"
            variant="outline"
            className="h-7 px-2 text-[11px] gap-1 border-destructive/30 text-destructive hover:bg-destructive/10"
            onClick={openBlock}
          >
            <Ban className="h-3 w-3" /> Block posting
          </Button>
        )}
      </div>

      {block && (
        <p className="text-[10px] text-muted-foreground whitespace-pre-line">
          {block.auto_blocked ? 'Auto-blocked (3 rejections): ' : 'Reason: '}{block.reason}
        </p>
      )}

      <Dialog open={dialogOpen} onOpenChange={(v) => { if (!busy) setDialogOpen(v); }}>
        <DialogContent className="sm:max-w-md rounded-2xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              {mode === 'block' ? <Ban className="h-5 w-5 text-destructive" /> : <ShieldCheck className="h-5 w-5 text-emerald-600" />}
              {mode === 'block' ? 'Block agent from posting' : 'Unblock agent'}
            </DialogTitle>
            <DialogDescription>
              {mode === 'block'
                ? `${agentName || 'This agent'} won't be able to list houses and earns no commission while blocked. They will read the reason you give.`
                : `${agentName || 'This agent'} will be able to list houses again immediately.`}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3 py-1">
            {mode === 'block' && (
              <div className="space-y-1.5">
                <Label className="text-xs">Block duration (days)</Label>
                <Input
                  type="number"
                  min={1}
                  value={days}
                  onChange={(e) => setDays(e.target.value)}
                  className="h-10"
                />
              </div>
            )}
            <div className="space-y-1.5">
              <Label className="text-xs">
                {mode === 'block' ? 'Reason the agent will read (min 10 characters)' : 'Note for the agent (optional)'}
              </Label>
              <Textarea
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder={mode === 'block'
                  ? 'e.g. Repeatedly listing houses with wrong landlord details. Please verify the landlord before listing.'
                  : 'e.g. Issue resolved — you may continue listing.'}
                rows={3}
              />
            </div>
          </div>

          <div className="flex gap-2">
            <Button variant="ghost" className="flex-1" disabled={busy} onClick={() => setDialogOpen(false)}>
              Cancel
            </Button>
            <Button
              className={`flex-1 ${mode === 'block' ? 'bg-destructive hover:bg-destructive/90 text-destructive-foreground' : ''}`}
              disabled={busy}
              onClick={submit}
            >
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : (mode === 'block' ? 'Block agent' : 'Unblock agent')}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

export default AgentListingBlockControl;