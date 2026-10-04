import { useCallback, useEffect, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Card } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Ban,
  ShieldCheck,
  Loader2,
  Search,
  Snowflake,
  ShieldAlert,
  Phone,
} from 'lucide-react';
import { toast } from 'sonner';

interface AgentRow {
  agent_id: string;
  full_name: string | null;
  phone: string | null;
  is_frozen: boolean;
  freeze_scope: string | null;
  blocked_until: string | null;
  reason: string | null;
}

/**
 * CTO Agent Freeze — search any agent by name/phone and freeze or unfreeze them.
 *
 * - Scope "all" blocks EVERY agent activity (collections, visits, receipts,
 *   listings, etc.) via DB triggers. Scope "listing" only stops house posting.
 * - Uses the existing `block_agent_listing` / `unblock_agent_listing` RPCs
 *   (authorised for CTO via is_landlord_ops) and notifies the agent by SMS.
 */
export function CTOAgentFreezePanel() {
  const [query, setQuery] = useState('');
  const [rows, setRows] = useState<AgentRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<AgentRow | null>(null);
  const [mode, setMode] = useState<'freeze' | 'unfreeze'>('freeze');
  const [scope, setScope] = useState<'all' | 'listing'>('all');
  const [reason, setReason] = useState('');
  const [days, setDays] = useState('8');
  const [busy, setBusy] = useState(false);

  const search = useCallback(async (q: string) => {
    setLoading(true);
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data, error } = await (supabase as any).rpc('cto_search_agents', {
        p_query: q?.trim() || null,
      });
      if (error) throw error;
      setRows((data as AgentRow[]) || []);
    } catch (err: any) {
      toast.error(err?.message || 'Search failed');
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    search('');
  }, [search]);

  useEffect(() => {
    const t = setTimeout(() => search(query), 350);
    return () => clearTimeout(t);
  }, [query, search]);

  const openFreeze = (row: AgentRow) => {
    setSelected(row);
    setMode('freeze');
    setScope('all');
    setReason('');
    setDays('8');
  };
  const openUnfreeze = (row: AgentRow) => {
    setSelected(row);
    setMode('unfreeze');
    setReason('');
  };

  const submit = async () => {
    if (!selected) return;
    if (mode === 'freeze' && reason.trim().length < 10) {
      toast.error('Reason must be at least 10 characters', {
        description: 'The agent will read this, so explain clearly why they are frozen.',
      });
      return;
    }
    setBusy(true);
    try {
      if (mode === 'freeze') {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const { error } = await (supabase as any).rpc('block_agent_listing', {
          p_agent_id: selected.agent_id,
          p_reason: reason.trim(),
          p_days: Math.max(1, Number(days) || 8),
          p_scope: scope,
        });
        if (error) throw error;
        // Notify the agent by SMS and surface whether it actually went out.
        let smsSent = false;
        let smsNote = '';
        try {
          const { data: smsRes, error: smsErr } = await supabase.functions.invoke(
            'notify-agent-frozen',
            { body: { agent_id: selected.agent_id } },
          );
          if (smsErr) throw smsErr;
          smsSent = !!(smsRes as any)?.sms_sent;
          if (!smsSent && (smsRes as any)?.phone_present === false) {
            smsNote = 'Agent has no phone on file — no SMS sent.';
          } else if (!smsSent) {
            smsNote = 'SMS could not be delivered — try again.';
          }
        } catch (smsErr: any) {
          smsNote = 'SMS failed to send — the freeze is still applied.';
        }
        const base = scope === 'all' ? 'Agent frozen — all activity blocked' : 'Agent blocked from posting houses';
        if (smsSent) {
          toast.success(`${base}. Agent notified by SMS.`);
        } else {
          toast.warning(base, { description: smsNote || 'Agent could not be notified by SMS.' });
        }
      } else {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const { error } = await (supabase as any).rpc('unblock_agent_listing', {
          p_agent_id: selected.agent_id,
          p_reason: reason.trim() || null,
        });
        if (error) throw error;
        toast.success('Agent unfrozen — activity restored');
      }
      setSelected(null);
      await search(query);
    } catch (err: any) {
      toast.error(err?.message || 'Action failed');
    } finally {
      setBusy(false);
    }
  };

  const frozenCount = rows.filter((r) => r.is_frozen).length;

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h2 className="text-lg font-bold flex items-center gap-2">
            <Snowflake className="h-5 w-5 text-sky-600" /> Agent Freeze Controls
          </h2>
          <p className="text-xs text-muted-foreground mt-0.5 max-w-xl">
            Freeze any agent from all activity (or just house posting) with a reason and
            duration. The agent is notified by SMS and blocked at the database level.
          </p>
        </div>
        {frozenCount > 0 && (
          <Badge className="bg-destructive/10 text-destructive border-0 font-bold h-6 px-2">
            <ShieldAlert className="h-3.5 w-3.5 mr-1" /> {frozenCount} frozen
          </Badge>
        )}
      </div>

      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search agent by name or phone…"
          className="pl-9 h-11"
        />
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-10 text-sm text-muted-foreground gap-2">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading agents…
        </div>
      ) : rows.length === 0 ? (
        <div className="text-center py-10 text-sm text-muted-foreground">
          No agents found.
        </div>
      ) : (
        <div className="space-y-2">
          {rows.map((row) => (
            <Card key={row.agent_id} className="p-3">
              <div className="flex items-center justify-between gap-3 flex-wrap">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-semibold text-sm truncate">
                      {row.full_name || 'Unnamed agent'}
                    </span>
                    {row.is_frozen ? (
                      <Badge className="bg-destructive/10 text-destructive border-0 text-[10px] h-5 px-1.5 font-bold">
                        <Ban className="h-3 w-3 mr-0.5" />
                        {row.freeze_scope === 'all' ? 'Frozen' : 'Posting blocked'}
                        {row.blocked_until
                          ? ` · until ${new Date(row.blocked_until).toLocaleDateString()}`
                          : ''}
                      </Badge>
                    ) : (
                      <Badge className="bg-emerald-100 text-emerald-700 border-0 text-[10px] h-5 px-1.5 font-bold">
                        <ShieldCheck className="h-3 w-3 mr-0.5" /> Active
                      </Badge>
                    )}
                  </div>
                  <div className="flex items-center gap-1 text-[11px] text-muted-foreground mt-0.5">
                    <Phone className="h-3 w-3" /> {row.phone || 'No phone'}
                  </div>
                  {row.is_frozen && row.reason && (
                    <p className="text-[10px] text-muted-foreground mt-1 whitespace-pre-line">
                      Reason: {row.reason}
                    </p>
                  )}
                </div>
                {row.is_frozen ? (
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-8 px-2.5 text-[12px] gap-1 shrink-0"
                    onClick={() => openUnfreeze(row)}
                  >
                    <ShieldCheck className="h-3.5 w-3.5" /> Unfreeze
                  </Button>
                ) : (
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-8 px-2.5 text-[12px] gap-1 shrink-0 border-destructive/30 text-destructive hover:bg-destructive/10"
                    onClick={() => openFreeze(row)}
                  >
                    <Snowflake className="h-3.5 w-3.5" /> Freeze
                  </Button>
                )}
              </div>
            </Card>
          ))}
        </div>
      )}

      <Dialog open={!!selected} onOpenChange={(v) => { if (!busy && !v) setSelected(null); }}>
        <DialogContent className="sm:max-w-md rounded-2xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              {mode === 'freeze' ? (
                <Snowflake className="h-5 w-5 text-destructive" />
              ) : (
                <ShieldCheck className="h-5 w-5 text-emerald-600" />
              )}
              {mode === 'freeze' ? 'Freeze agent' : 'Unfreeze agent'}
            </DialogTitle>
            <DialogDescription>
              {mode === 'freeze'
                ? `${selected?.full_name || 'This agent'} will be notified by SMS and blocked at the database level. They will read the reason you give.`
                : `${selected?.full_name || 'This agent'} will be able to work again immediately.`}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3 py-1">
            {mode === 'freeze' && (
              <>
                <div className="space-y-1.5">
                  <Label className="text-xs">Freeze scope</Label>
                  <div className="grid grid-cols-2 gap-2">
                    <button
                      type="button"
                      onClick={() => setScope('all')}
                      className={`rounded-lg border p-2.5 text-left text-xs transition ${scope === 'all' ? 'border-destructive bg-destructive/5 ring-1 ring-destructive/30' : 'border-border'}`}
                    >
                      <span className="font-semibold block">All activity</span>
                      <span className="text-[10px] text-muted-foreground">No agent action allowed</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => setScope('listing')}
                      className={`rounded-lg border p-2.5 text-left text-xs transition ${scope === 'listing' ? 'border-destructive bg-destructive/5 ring-1 ring-destructive/30' : 'border-border'}`}
                    >
                      <span className="font-semibold block">Posting only</span>
                      <span className="text-[10px] text-muted-foreground">Cannot list houses</span>
                    </button>
                  </div>
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">Freeze duration (days)</Label>
                  <Input
                    type="number"
                    min={1}
                    value={days}
                    onChange={(e) => setDays(e.target.value)}
                    className="h-10"
                  />
                </div>
              </>
            )}
            <div className="space-y-1.5">
              <Label className="text-xs">
                {mode === 'freeze' ? 'Reason the agent will read (min 10 characters)' : 'Note for the agent (optional)'}
              </Label>
              <Textarea
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder={mode === 'freeze'
                  ? 'e.g. Manipulation of the system and improper use of the platform.'
                  : 'e.g. Issue resolved — you may resume work.'}
                rows={3}
              />
            </div>
          </div>

          <div className="flex gap-2">
            <Button variant="ghost" className="flex-1" disabled={busy} onClick={() => setSelected(null)}>
              Cancel
            </Button>
            <Button
              className={`flex-1 ${mode === 'freeze' ? 'bg-destructive hover:bg-destructive/90 text-destructive-foreground' : ''}`}
              disabled={busy}
              onClick={submit}
            >
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : (mode === 'freeze' ? 'Freeze agent' : 'Unfreeze agent')}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

export default CTOAgentFreezePanel;