/**
 * OnboardProxyAgentDialog — lets Partner Ops directly onboard an existing
 * agent as an approved proxy agent (skipping the self-application flow).
 * Lookup + onboarding both go through partner_ops_* SECURITY DEFINER RPCs.
 */
import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { BadgeCheck, Loader2, Search, UserPlus } from 'lucide-react';

import { supabase } from '@/integrations/supabase/client';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useToast } from '@/hooks/use-toast';
import { cn } from '@/lib/utils';

interface AgentMatch {
  agent_user_id: string;
  full_name: string | null;
  phone: string | null;
  email: string | null;
  is_agent: boolean | null;
  proxy_status: string | null;
}

const statusTone: Record<string, string> = {
  approved: 'bg-emerald-500/15 text-emerald-600 border-emerald-500/30',
  pending: 'bg-amber-500/15 text-amber-600 border-amber-500/30',
  rejected: 'bg-destructive/15 text-destructive border-destructive/30',
  suspended: 'bg-muted text-muted-foreground border-border',
};

export function OnboardProxyAgentDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [phone, setPhone] = useState('');
  const [matches, setMatches] = useState<AgentMatch[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [selected, setSelected] = useState<AgentMatch | null>(null);
  const [nin, setNin] = useState('');
  const [notes, setNotes] = useState('');

  const reset = () => {
    setPhone('');
    setMatches(null);
    setSelected(null);
    setNin('');
    setNotes('');
  };

  const search = async () => {
    const term = phone.trim();
    if (term.length < 3) {
      toast({ title: 'Enter at least 3 characters — name, email or phone', variant: 'destructive' });
      return;
    }
    setSearching(true);
    setSelected(null);
    const { data, error } = await supabase.rpc('partner_ops_find_agent_for_proxy', { p_phone: term });
    setSearching(false);
    if (error) {
      toast({ title: 'Search failed', description: error.message, variant: 'destructive' });
      return;
    }
    setMatches((data ?? []) as unknown as AgentMatch[]);
  };

  const onboard = useMutation({
    mutationFn: async () => {
      if (!selected) throw new Error('Select an agent first');
      const { data, error } = await supabase.rpc('partner_ops_onboard_proxy_agent', {
        p_agent_user_id: selected.agent_user_id,
        p_nin: nin.trim() || null,
        p_notes: notes.trim() || null,
      });
      if (error) throw new Error(error.message);
      const result = (data ?? {}) as { email?: string | null; full_name?: string | null };
      const recipientEmail = (result.email ?? selected.email ?? '').trim();
      if (recipientEmail) {
        // Best-effort role/benefits notification — never block onboarding on it.
        void supabase.functions
          .invoke('send-transactional-email', {
            body: {
              templateName: 'proxy-agent-onboarded',
              recipientEmail,
              idempotencyKey: `proxy-agent-onboarded-${selected.agent_user_id}-${new Date().toISOString().slice(0, 10)}`,
              templateData: {
                recipient_name: result.full_name ?? selected.full_name ?? 'there',
                onboarded_on: new Date().toLocaleDateString('en-GB', {
                  day: '2-digit',
                  month: 'long',
                  year: 'numeric',
                }),
              },
            },
          })
          .catch((err) => console.error('Failed to send proxy agent onboarding email:', err));
      }
      return data;
    },
    onSuccess: () => {
      toast({ title: 'Proxy agent onboarded', description: `${selected?.full_name ?? 'Agent'} is now an approved proxy agent.` });
      void qc.invalidateQueries({ queryKey: ['proxy-agent-directory'] });
      void qc.invalidateQueries({ queryKey: ['proxy-agent-applications'] });
      void qc.invalidateQueries({ queryKey: ['proxy-onboarding-audit'] });
      onOpenChange(false);
      reset();
    },
    onError: (e) =>
      toast({ title: 'Onboarding failed', description: e instanceof Error ? e.message : 'Unknown error', variant: 'destructive' }),
  });

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        onOpenChange(v);
        if (!v) reset();
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base">
            <UserPlus className="h-4 w-4 text-primary" />
            Onboard Proxy Agent
          </DialogTitle>
          <DialogDescription className="text-xs">
            Search any user by name, email or phone and approve them as a proxy agent — no
            self-application needed. They get an email explaining the role and its benefits.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="proxy-phone" className="text-xs">Search by name, email or phone</Label>
            <div className="flex gap-2">
              <Input
                id="proxy-phone"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && search()}
                placeholder="e.g. Timothy, name@email.com or 0748 762 871"
                className="h-9 text-sm"
              />
              <Button size="sm" className="h-9" onClick={search} disabled={searching}>
                {searching ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
                <span className="ml-1.5">Find</span>
              </Button>
            </div>
          </div>

          {matches && (
            <div className="space-y-1.5">
              {matches.length === 0 ? (
                <p className="rounded-lg border border-dashed p-3 text-center text-xs text-muted-foreground">
                  No user found. Try a different name, email or phone number.
                </p>
              ) : (
                matches.map((m) => {
                  const alreadyApproved = m.proxy_status === 'approved';
                  const isSelected = selected?.agent_user_id === m.agent_user_id;
                  return (
                    <button
                      key={m.agent_user_id}
                      type="button"
                      disabled={alreadyApproved}
                      onClick={() => setSelected(m)}
                      className={cn(
                        'flex w-full items-center justify-between gap-2 rounded-lg border p-2.5 text-left transition-colors',
                        isSelected ? 'border-primary bg-primary/5' : 'hover:bg-muted/50',
                        alreadyApproved && 'cursor-not-allowed opacity-60',
                      )}
                    >
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium">{m.full_name || 'Unnamed user'}</p>
                        <p className="truncate text-xs text-muted-foreground">
                          {[m.phone, m.email].filter(Boolean).join(' · ') || '—'}
                        </p>
                        {!m.is_agent && !m.proxy_status && (
                          <p className="truncate text-[10px] text-muted-foreground">
                            Will also be given the agent role
                          </p>
                        )}
                      </div>
                      {m.proxy_status ? (
                        <Badge variant="outline" className={cn('shrink-0 text-[10px]', statusTone[m.proxy_status] ?? '')}>
                          {alreadyApproved ? 'already proxy' : m.proxy_status}
                        </Badge>
                      ) : (
                        isSelected && <BadgeCheck className="h-4 w-4 shrink-0 text-primary" />
                      )}
                    </button>
                  );
                })
              )}
            </div>
          )}

          {selected && (
            <>
              <div className="space-y-1.5">
                <Label htmlFor="proxy-nin" className="text-xs">National ID (NIN) — optional</Label>
                <Input
                  id="proxy-nin"
                  value={nin}
                  onChange={(e) => setNin(e.target.value)}
                  placeholder="e.g. CM12345678ABC"
                  className="h-9 text-sm"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="proxy-notes" className="text-xs">Notes — optional</Label>
                <Textarea
                  id="proxy-notes"
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  placeholder="Why is this agent being onboarded directly?"
                  rows={2}
                  className="text-sm"
                />
              </div>
            </>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button size="sm" disabled={!selected || onboard.isPending} onClick={() => onboard.mutate()}>
            {onboard.isPending && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
            Approve as Proxy Agent
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
