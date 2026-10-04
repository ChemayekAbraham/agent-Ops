import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { useToast } from '@/hooks/use-toast';
import { extractEdgeFunctionError } from '@/lib/extractEdgeFunctionError';
import { getPublicOrigin } from '@/lib/getPublicOrigin';
import { Search, Loader2, UserPlus, UsersRound, CheckCircle2, UserCheck, Copy, Check, Share2 } from 'lucide-react';
import { cn } from '@/lib/utils';

interface UserResult {
  id: string;
  full_name: string | null;
  phone: string | null;
  email: string | null;
}

interface ExistingLink {
  sub_agent_id: string;
  parent_agent_id: string;
  parent_name: string | null;
  status: string | null;
  expires_at: string | null;
}

interface AddSubAgentSearchProps {
  onAdded?: () => void;
}

export function AddSubAgentSearch({ onAdded }: AddSubAgentSearchProps) {
  const { user } = useAuth();
  const { toast } = useToast();
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<UserResult | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState('');
  const [sentInvite, setSentInvite] = useState<{ name: string; link: string; hasEmail: boolean } | null>(null);
  const [copied, setCopied] = useState(false);

  const term = query.trim();

  const { data: results, isFetching } = useQuery({
    queryKey: ['add-subagent-search', term],
    enabled: term.length >= 2,
    staleTime: 10_000,
    queryFn: async (): Promise<UserResult[]> => {
      // Use a SECURITY DEFINER RPC: a normal agent cannot read other users'
      // profiles directly (RLS only exposes their own + managed tenants), so
      // the client-side `profiles` query returned no results for them.
      const { data, error } = await supabase.rpc('search_invitable_subagents', {
        search_term: term,
        result_limit: 15,
      });
      if (error) throw error;
      return ((data || []) as UserResult[]).filter((p) => p.id !== user?.id);
    },
  });

  const resultIds = (results || []).map((r) => r.id);

  // Find which of the searched users already have agent_subagents links (any agent)
  const { data: existingLinks } = useQuery({
    queryKey: ['add-subagent-existing-links', resultIds, user?.id],
    enabled: resultIds.length > 0 && !!user?.id,
    staleTime: 10_000,
    queryFn: async (): Promise<Record<string, ExistingLink>> => {
      const { data, error } = await supabase
        .from('agent_subagents')
        .select('sub_agent_id, parent_agent_id, status, expires_at')
        .in('sub_agent_id', resultIds)
        .not('status', 'in', '("rejected","cancelled")');
      if (error) throw error;
      const rows = data || [];
      const parentIds = Array.from(new Set(rows.map((r) => r.parent_agent_id)));
      let names: Record<string, string | null> = {};
      if (parentIds.length > 0) {
        const { data: parents } = await supabase
          .from('profiles')
          .select('id, full_name')
          .in('id', parentIds);
        names = Object.fromEntries((parents || []).map((p) => [p.id, p.full_name]));
      }
      const map: Record<string, ExistingLink> = {};
      for (const r of rows) {
        // keep the first/strongest link per sub-agent (verified wins over pending)
        if (!map[r.sub_agent_id] || r.status === 'verified') {
          map[r.sub_agent_id] = {
            sub_agent_id: r.sub_agent_id,
            parent_agent_id: r.parent_agent_id,
            parent_name: names[r.parent_agent_id] ?? null,
            status: r.status,
            expires_at: r.expires_at,
          };
        }
      }
      return map;
    },
  });

  // Classify an existing link's pending state. A pending invite that has passed
  // its expiry (or is explicitly `expired`) may be re-sent; a still-valid
  // pending invite must NOT be re-invited/re-selected.
  const classifyLink = (link?: ExistingLink | null) => {
    if (!link) return { isVerified: false, isPendingActive: false, isExpired: false };
    const isVerified = link.status === 'verified';
    const expired =
      link.status === 'expired' ||
      (link.status === 'pending_acceptance' &&
        !!link.expires_at &&
        new Date(link.expires_at).getTime() <= Date.now());
    const isPendingActive = link.status === 'pending_acceptance' && !expired;
    return { isVerified, isPendingActive, isExpired: expired && !isVerified };
  };

  const handleAdd = async () => {
    if (!selected) return;
    setSubmitting(true);
    try {
      const response = await supabase.functions.invoke('add-existing-subagent', {
        body: { subAgentId: selected.id, origin: getPublicOrigin(), inviteMessage: message.trim() || undefined },
      });
      if (response.error || response.data?.error) {
        const msg = await extractEdgeFunctionError(response, 'Could not add sub-agent.');
        throw new Error(msg);
      }
      const name = selected.full_name || 'User';
      if (response.data?.alreadyLinked) {
        toast({
          title: 'Already your sub-agent',
          description: `${name} is already your sub-agent.`,
        });
        setSelected(null);
        setQuery('');
        setMessage('');
        onAdded?.();
      } else {
        const hasEmail = !!response.data?.hasEmail;
        toast({
          title: 'Invitation created!',
          description: hasEmail
            ? `${name} will see it on their dashboard and get an email. You can also share the link below.`
            : `${name} will see it on their dashboard. Share the link below with them too.`,
        });
        setSentInvite({ name, link: response.data?.acceptLink || '', hasEmail });
        setSelected(null);
        setQuery('');
        setMessage('');
        onAdded?.();
      }
    } catch (err: any) {
      toast({
        title: 'Failed to add sub-agent',
        description: err?.message || 'Please try again.',
        variant: 'destructive',
      });
    } finally {
      setSubmitting(false);
    }
  };

  const handleCopyLink = async () => {
    if (!sentInvite?.link) return;
    try {
      await navigator.clipboard.writeText(sentInvite.link);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
      toast({ title: 'Link copied!', description: 'Share it with your sub-agent.' });
    } catch {
      toast({ title: 'Could not copy', description: 'Please copy the link manually.', variant: 'destructive' });
    }
  };

  const handleShareLink = async () => {
    if (!sentInvite?.link) return;
    const shareText = `I'm inviting you to become my sub-agent on Welile. Tap to accept: ${sentInvite.link}`;
    if (navigator.share) {
      try {
        await navigator.share({ title: 'Welile sub-agent invite', text: shareText, url: sentInvite.link });
        return;
      } catch {
        /* user cancelled — fall through to WhatsApp */
      }
    }
    window.open(`https://wa.me/?text=${encodeURIComponent(shareText)}`, '_blank');
  };

  return (
    <Card className="border-2 border-orange-500/30 bg-gradient-to-br from-orange-500/5 to-amber-500/5">
      <CardContent className="p-4 space-y-3">
        <div className="flex items-center gap-2">
          <div className="p-2 rounded-lg bg-orange-500/15 text-orange-600">
            <UsersRound className="h-4 w-4" />
          </div>
          <div>
            <h3 className="font-bold text-sm">Add an existing user as your sub-agent</h3>
            <p className="text-[11px] text-muted-foreground">
              Search any registered user, then invite them. They'll see it on their dashboard and by email — or share the link yourself.
            </p>
          </div>
        </div>

        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setSelected(null);
            }}
            placeholder="Search by name, phone, or email"
            className="pl-9 h-12"
          />
          {isFetching && (
            <Loader2 className="absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 animate-spin text-muted-foreground" />
          )}
        </div>

        {term.length >= 2 && !selected && (
          <div className="border border-border rounded-lg max-h-56 overflow-y-auto bg-card">
            {!isFetching && (results?.length || 0) === 0 && (
              <div className="p-3 text-sm text-muted-foreground">No matching users.</div>
            )}
            {(results || []).map((u) => {
              const link = existingLinks?.[u.id];
              const isMine = link?.parent_agent_id === user?.id;
              const isOther = link && !isMine;
              const { isVerified: isVerifiedSubAgent, isPendingActive, isExpired } = classifyLink(link);
              // A still-valid pending invite from ME cannot be re-selected or
              // re-invited — only an expired one may be re-sent.
              const isMinePending = !!isMine && isPendingActive;
              const isMineExpired = !!isMine && isExpired;
              const isOtherPending = !!isOther && isPendingActive;
              // Block selection when verified anywhere, or when I have a live pending invite.
              const blocked = isVerifiedSubAgent || isMinePending;
              let badge: { label: string; variant: any; icon?: typeof UserCheck } = {
                label: 'Eligible',
                variant: 'success',
              };
              if (isVerifiedSubAgent) {
                badge = { label: 'Sub-agent', variant: 'success', icon: UserCheck };
              } else if (isMinePending) {
                badge = { label: 'Invite pending', variant: 'warning', icon: UserCheck };
              } else if (isMineExpired) {
                badge = { label: 'Invite expired', variant: 'warning' };
              } else if (isOtherPending) {
                badge = { label: 'Invite pending', variant: 'warning', icon: UserCheck };
              }
              const tooltipText = (() => {
                if (isVerifiedSubAgent) {
                  return isMine
                    ? 'This user is already your sub-agent, so they can’t be invited again.'
                    : 'This user is already a sub-agent, so they can’t be invited.';
                }
                if (isMinePending) {
                  return 'You already have a pending invite for this user. You can’t re-invite them until the invite expires.';
                }
                if (isMineExpired) {
                  return 'Your previous invite to this user expired. You can send a fresh invite.';
                }
                if (isOtherPending) {
                  return 'Another agent already invited this user. If you send an invite, they can choose which agent to join.';
                }
                return 'No existing sub-agent link found. Inviting them shows the request on their dashboard and emails an acceptance link.';
              })();

              return (
                <button
                  key={u.id}
                  type="button"
                  disabled={blocked}
                  onClick={() => { if (!blocked) setSelected(u); }}
                  className={cn(
                    'w-full flex items-center gap-2 p-3 text-left text-sm border-b border-border last:border-b-0 transition-colors',
                    blocked
                      ? 'opacity-60 cursor-not-allowed'
                      : 'hover:bg-accent',
                  )}
                >
                  <div className="min-w-0 flex-1">
                    <div className="font-medium truncate">{u.full_name || 'Unnamed'}</div>
                    <div className="text-xs text-muted-foreground truncate">
                      {u.phone || u.email || u.id.slice(0, 8)}
                    </div>
                  </div>
                  <TooltipProvider delayDuration={200}>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Badge
                          variant={badge.variant}
                          className={cn(
                            'shrink-0 text-[10px] cursor-help',
                            badge.variant === 'warning' && 'border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400',
                            badge.variant === 'success' && 'border-green-500/40 bg-green-500/10 text-green-700 dark:text-green-400'
                          )}
                        >
                          {badge.icon && <badge.icon className="h-3 w-3 mr-1" />}
                          {badge.label}
                        </Badge>
                      </TooltipTrigger>
                      <TooltipContent side="left" className="max-w-xs text-xs leading-relaxed">
                        {tooltipText}
                      </TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                </button>
              );
            })}
          </div>
        )}

        {selected && (
          <div className="space-y-3">
            {(() => {
              const link = existingLinks?.[selected.id];
              const isMine = link?.parent_agent_id === user?.id;
              const isOther = link && !isMine;
              const { isVerified, isPendingActive, isExpired } = classifyLink(link);
              if (isMine && isVerified) {
                return (
                  <div className="flex items-start gap-2 p-3 rounded-lg bg-green-500/10 border border-green-500/30 text-xs text-green-800 dark:text-green-300">
                    <CheckCircle2 className="h-4 w-4 shrink-0 mt-0.5" />
                    <span>
                      This user is already your sub-agent. No need to invite again.
                    </span>
                  </div>
                );
              }
              if (isMine && isPendingActive) {
                return (
                  <div className="flex items-start gap-2 p-3 rounded-lg bg-amber-500/10 border border-amber-500/30 text-xs text-amber-800 dark:text-amber-300">
                    <UserCheck className="h-4 w-4 shrink-0 mt-0.5" />
                    <span>
                      You already have a pending invite for this user. You can’t re-invite them until the invite expires.
                    </span>
                  </div>
                );
              }
              if (isMine && isExpired) {
                return (
                  <div className="flex items-start gap-2 p-3 rounded-lg bg-amber-500/10 border border-amber-500/30 text-xs text-amber-800 dark:text-amber-300">
                    <UserCheck className="h-4 w-4 shrink-0 mt-0.5" />
                    <span>
                      Your previous invite to this user expired. You can send a fresh invite.
                    </span>
                  </div>
                );
              }
              if (isOther) {
                return (
                  <div className="flex items-start gap-2 p-3 rounded-lg bg-amber-500/10 border border-amber-500/30 text-xs text-amber-800 dark:text-amber-300">
                    <UserCheck className="h-4 w-4 shrink-0 mt-0.5" />
                    <span>
                      This user is already
                      {link.status === 'verified' ? ' a sub-agent of ' : ' invited by '}
                      <span className="font-semibold">
                        {link.parent_name || 'another agent'}
                      </span>
                      . You can still send your invitation — they choose which agent to join.
                    </span>
                  </div>
                );
              }
              return null;
            })()}
            <div className={cn('flex items-center gap-2 p-3 rounded-lg bg-primary/5 border border-primary/20 text-sm')}>
              <CheckCircle2 className="h-4 w-4 text-primary shrink-0" />
              <div className="min-w-0 flex-1">
                <div className="font-medium truncate">{selected.full_name || 'Unnamed'}</div>
                <div className="text-xs text-muted-foreground truncate">
                  {selected.phone || selected.email}
                </div>
              </div>
              <Badge variant="outline" className="bg-background shrink-0">Selected</Badge>
            </div>
            <div className="space-y-1">
              <label className="text-[11px] font-medium text-muted-foreground">
                Add a short message (optional)
              </label>
              <Textarea
                value={message}
                onChange={(e) => setMessage(e.target.value.slice(0, 100))}
                placeholder="e.g. Join my team — I'll help you get started!"
                rows={2}
                maxLength={100}
                className="resize-none text-sm"
              />
              <div className="text-[10px] text-muted-foreground text-right">{message.length}/100</div>
            </div>
            <Button
              onClick={handleAdd}
              disabled={
                submitting ||
                (() => {
                  const link = existingLinks?.[selected.id];
                  const isMine = link?.parent_agent_id === user?.id;
                  const { isVerified, isPendingActive } = classifyLink(link);
                  return !!isMine && (isVerified || isPendingActive);
                })()
              }
              className="w-full h-11 gap-2 bg-orange-500 hover:bg-orange-600 text-white font-semibold"
            >
              {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <UserPlus className="h-4 w-4" />}
              Send sub-agent invite
            </Button>
          </div>
        )}

        {sentInvite && (
          <div className="space-y-2 p-3 rounded-lg bg-green-500/5 border border-green-500/30">
            <div className="flex items-start gap-2 text-xs text-green-800 dark:text-green-300">
              <CheckCircle2 className="h-4 w-4 shrink-0 mt-0.5" />
              <span>
                Invite created for <span className="font-semibold">{sentInvite.name}</span>.{' '}
                {sentInvite.hasEmail
                  ? 'They’ll see it on their dashboard and get an email.'
                  : 'They’ll see it on their dashboard.'}{' '}
                You can also share this link directly:
              </span>
            </div>
            {sentInvite.link && (
              <>
                <div className="flex items-center gap-2 p-2 rounded-md bg-background border border-border">
                  <code className="text-[11px] truncate flex-1 text-muted-foreground">{sentInvite.link}</code>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <Button type="button" variant="outline" size="sm" className="gap-1.5" onClick={handleCopyLink}>
                    {copied ? <Check className="h-3.5 w-3.5 text-green-600" /> : <Copy className="h-3.5 w-3.5" />}
                    {copied ? 'Copied' : 'Copy link'}
                  </Button>
                  <Button type="button" variant="outline" size="sm" className="gap-1.5" onClick={handleShareLink}>
                    <Share2 className="h-3.5 w-3.5" />
                    Share
                  </Button>
                </div>
              </>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export default AddSubAgentSearch;