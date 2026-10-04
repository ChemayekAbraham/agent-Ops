import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, Search, Loader2, ArchiveRestore, AlertTriangle, UserPlus, LifeBuoy, CheckCircle2, XCircle } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { useToast } from '@/hooks/use-toast';

interface ArchivedRow {
  id: string;
  full_name: string | null;
  phone: string | null;
  email: string | null;
  created_at: string;
}

type Mode = 'choose' | 'restore' | 'free';

interface VerificationResult {
  ok: boolean;
  mismatches: Array<{ field: string; auth: unknown; profile: unknown; note?: string }>;
  auth: { email: string | null; phone: string | null; deleted_at: string | null; banned_until: string | null };
  profile: { full_name: string | null; email: string | null; phone: string | null };
}

export default function ArchivedAccountsPage() {
  const navigate = useNavigate();
  const { toast } = useToast();
  const [rows, setRows] = useState<ArchivedRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [active, setActive] = useState<ArchivedRow | null>(null);
  const [mode, setMode] = useState<Mode>('choose');
  const [overrideEmail, setOverrideEmail] = useState('');
  const [overridePhone, setOverridePhone] = useState('');
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [quickRestoringId, setQuickRestoringId] = useState<string | null>(null);
  const [lastVerification, setLastVerification] = useState<{ name: string; result: VerificationResult } | null>(null);

  const load = async () => {
    setLoading(true);
    const { data, error } = await supabase
      .from('profiles')
      .select('id, full_name, phone, email, created_at')
      .ilike('full_name', '[ARCHIVED]%')
      .order('created_at', { ascending: false })
      .limit(500);
    if (error) {
      toast({ title: 'Failed to load archived accounts', description: error.message, variant: 'destructive' });
    } else {
      setRows((data as ArchivedRow[]) ?? []);
    }
    setLoading(false);
  };

  useEffect(() => { load(); }, []);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter(r =>
      (r.full_name || '').toLowerCase().includes(q) ||
      (r.phone || '').toLowerCase().includes(q) ||
      (r.email || '').toLowerCase().includes(q) ||
      r.id.toLowerCase().includes(q)
    );
  }, [rows, search]);

  const openRestore = (row: ArchivedRow) => {
    setActive(row);
    setMode('choose');
    setOverrideEmail('');
    setOverridePhone('');
    setReason('');
  };

  const submitRestore = async () => {
    if (!active) return;
    if (reason.trim().length < 10) {
      toast({ title: 'Reason too short', description: 'Provide at least 10 characters explaining the restore.', variant: 'destructive' });
      return;
    }
    setSubmitting(true);
    try {
      const { data, error } = await supabase.functions.invoke('restore-archived-account', {
        body: {
          user_id: active.id,
          reason: reason.trim(),
          email: overrideEmail.trim() || undefined,
          phone: overridePhone.trim() || undefined,
        },
      });
      if (error) throw new Error(error.message);
      if ((data as any)?.error) throw new Error((data as any).error);
      const v = (data as any)?.verification as VerificationResult | undefined;
      const name = (data as any)?.restored_name || 'User';
      if (v) setLastVerification({ name, result: v });
      toast({
        title: v && !v.ok ? 'Restored with mismatches' : 'Account restored & verified',
        description: v && !v.ok
          ? `${name}: ${v.mismatches.length} field${v.mismatches.length === 1 ? '' : 's'} need review.`
          : `${name} can now sign in again.`,
        variant: v && !v.ok ? 'destructive' : 'default',
      });
      setActive(null);
      await load();
    } catch (e: any) {
      toast({ title: 'Restore failed', description: e?.message || 'Unknown error', variant: 'destructive' });
    } finally {
      setSubmitting(false);
    }
  };

  const submitFreeForResignup = async () => {
    if (!active) return;
    if (reason.trim().length < 10) {
      toast({ title: 'Reason too short', description: 'Provide at least 10 characters explaining why credentials are being freed.', variant: 'destructive' });
      return;
    }
    setSubmitting(true);
    try {
      const { data, error } = await supabase.functions.invoke('free-credentials-for-resignup', {
        body: { user_id: active.id, reason: reason.trim() },
      });
      if (error) throw new Error(error.message);
      if ((data as any)?.error) throw new Error((data as any).error);
      toast({
        title: 'Credentials freed',
        description: `${active.phone || active.email || 'The user'} can now register fresh.`,
      });
      setActive(null);
      await load();
    } catch (e: any) {
      toast({ title: 'Failed to free credentials', description: e?.message || 'Unknown error', variant: 'destructive' });
    } finally {
      setSubmitting(false);
    }
  };

  const quickRestore = async (row: ArchivedRow) => {
    setQuickRestoringId(row.id);
    try {
      const { data, error } = await supabase.functions.invoke('restore-archived-account', {
        body: {
          user_id: row.id,
          reason: 'One-click restore from Archived Accounts admin page',
        },
      });
      if (error) throw new Error(error.message);
      if ((data as any)?.error) throw new Error((data as any).error);
      const v = (data as any)?.verification as VerificationResult | undefined;
      const name = (data as any)?.restored_name || row.full_name?.replace(/^\[ARCHIVED\]\s*/i, '') || 'User';
      if (v) setLastVerification({ name, result: v });
      toast({
        title: v && !v.ok ? 'Restored with mismatches' : 'Account restored & verified',
        description: v && !v.ok
          ? `${name}: ${v.mismatches.length} field${v.mismatches.length === 1 ? '' : 's'} need review.`
          : `${name} can sign in again.`,
        variant: v && !v.ok ? 'destructive' : 'default',
      });
      await load();
    } catch (e: any) {
      toast({
        title: 'Quick restore failed',
        description: `${e?.message || 'Unknown error'}. Try "Resolve" for override options.`,
        variant: 'destructive',
      });
    } finally {
      setQuickRestoringId(null);
    }
  };

  return (
    <div className="min-h-screen bg-background p-4 md:p-8">
      <div className="max-w-5xl mx-auto space-y-6">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="icon" onClick={() => navigate(-1)}>
            <ArrowLeft className="h-5 w-5" />
          </Button>
          <div className="flex-1">
            <h1 className="text-2xl font-bold">Archived Accounts</h1>
            <p className="text-sm text-muted-foreground">
              Restore soft-deleted accounts. This clears the deletion timestamp and re-attaches the original email/phone so the user can sign in again.
            </p>
          </div>
          <Button variant="outline" size="sm" onClick={() => navigate('/admin/account-conflicts')}>
            Conflict resolver
          </Button>
        </div>

        {lastVerification && (
          <Card className={lastVerification.result.ok ? 'border-green-500/40' : 'border-destructive/50'}>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm flex items-center gap-2">
                {lastVerification.result.ok ? (
                  <CheckCircle2 className="h-4 w-4 text-green-600" />
                ) : (
                  <XCircle className="h-4 w-4 text-destructive" />
                )}
                Verification report — {lastVerification.name}
                <button
                  type="button"
                  className="ml-auto text-xs text-muted-foreground hover:text-foreground"
                  onClick={() => setLastVerification(null)}
                >
                  Dismiss
                </button>
              </CardTitle>
            </CardHeader>
            <CardContent className="text-xs space-y-2">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                <div className="rounded border p-2 bg-muted/30">
                  <div className="font-medium mb-1">auth.users</div>
                  <div>email: <span className="font-mono">{lastVerification.result.auth.email ?? '—'}</span></div>
                  <div>phone: <span className="font-mono">{lastVerification.result.auth.phone ?? '—'}</span></div>
                  <div>deleted_at: <span className="font-mono">{lastVerification.result.auth.deleted_at ?? '—'}</span></div>
                  <div>banned_until: <span className="font-mono">{lastVerification.result.auth.banned_until ?? '—'}</span></div>
                </div>
                <div className="rounded border p-2 bg-muted/30">
                  <div className="font-medium mb-1">profiles</div>
                  <div>full_name: <span className="font-mono">{lastVerification.result.profile.full_name ?? '—'}</span></div>
                  <div>email: <span className="font-mono">{lastVerification.result.profile.email ?? '—'}</span></div>
                  <div>phone: <span className="font-mono">{lastVerification.result.profile.phone ?? '—'}</span></div>
                </div>
              </div>
              {lastVerification.result.ok ? (
                <p className="text-green-700 dark:text-green-400">All fields match. Account is fully restored.</p>
              ) : (
                <div className="space-y-1">
                  <p className="text-destructive font-medium">
                    {lastVerification.result.mismatches.length} mismatch{lastVerification.result.mismatches.length === 1 ? '' : 'es'} detected:
                  </p>
                  <ul className="space-y-1">
                    {lastVerification.result.mismatches.map((m, i) => (
                      <li key={i} className="rounded border border-destructive/30 bg-destructive/5 p-2">
                        <div className="font-medium">{m.field}</div>
                        <div className="text-muted-foreground">auth: <span className="font-mono">{String(m.auth ?? '—')}</span></div>
                        <div className="text-muted-foreground">profile: <span className="font-mono">{String(m.profile ?? '—')}</span></div>
                        {m.note && <div className="text-destructive/80 mt-0.5">{m.note}</div>}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </CardContent>
          </Card>
        )}

        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between gap-3">
              <CardTitle className="text-base">{loading ? 'Loading…' : `${filtered.length} archived account${filtered.length === 1 ? '' : 's'}`}</CardTitle>
              <div className="relative w-full max-w-xs">
                <Search className="absolute left-2 top-2.5 h-4 w-4 text-muted-foreground" />
                <Input
                  className="pl-8"
                  placeholder="Search name, phone, email, id…"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
              </div>
            </div>
          </CardHeader>
          <CardContent>
            {loading ? (
              <div className="flex items-center justify-center py-12">
                <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
              </div>
            ) : filtered.length === 0 ? (
              <p className="text-sm text-muted-foreground py-12 text-center">No archived accounts match.</p>
            ) : (
              <div className="divide-y">
                {filtered.map(row => (
                  <div key={row.id} className="py-3 flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <p className="font-medium truncate">{row.full_name || '—'}</p>
                      <p className="text-xs text-muted-foreground truncate">
                        {row.phone || '—'} · {row.email || '—'}
                      </p>
                      <p className="text-[10px] text-muted-foreground font-mono mt-0.5">{row.id}</p>
                    </div>
                    <div className="flex items-center gap-2 flex-shrink-0">
                      <Button
                        size="sm"
                        onClick={() => quickRestore(row)}
                        disabled={quickRestoringId === row.id}
                      >
                        {quickRestoringId === row.id ? (
                          <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />
                        ) : (
                          <ArchiveRestore className="h-4 w-4 mr-1.5" />
                        )}
                        Restore
                      </Button>
                      <Button size="sm" variant="outline" onClick={() => openRestore(row)}>
                        <LifeBuoy className="h-4 w-4 mr-1.5" />
                        Resolve
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      <Dialog open={!!active} onOpenChange={(o) => !o && setActive(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <LifeBuoy className="h-5 w-5" />
              Resolve account access
            </DialogTitle>
            <DialogDescription>
              <strong>{active?.full_name?.replace(/^\[ARCHIVED\]\s*/i, '') || 'This account'}</strong>{' '}
              ({active?.phone || active?.email || 'no contact'}) is archived. Pick the path that matches the user's situation.
            </DialogDescription>
          </DialogHeader>

          {mode === 'choose' && (
            <div className="space-y-3 py-2">
              <button
                type="button"
                onClick={() => setMode('restore')}
                className="w-full text-left rounded-lg border bg-card p-4 hover:border-primary hover:bg-accent transition-colors"
              >
                <div className="flex items-start gap-3">
                  <div className="rounded-md bg-primary/10 p-2"><ArchiveRestore className="h-5 w-5 text-primary" /></div>
                  <div className="min-w-0">
                    <p className="font-medium">Un-archive &amp; restore</p>
                    <p className="text-sm text-muted-foreground mt-0.5">
                      Best when the deletion was a <strong>mistake</strong>. Clears the deletion flag, re-attaches the original email/phone, and lets the user sign in again with the same credentials and history.
                    </p>
                  </div>
                </div>
              </button>

              <button
                type="button"
                onClick={() => setMode('free')}
                className="w-full text-left rounded-lg border bg-card p-4 hover:border-primary hover:bg-accent transition-colors"
              >
                <div className="flex items-start gap-3">
                  <div className="rounded-md bg-primary/10 p-2"><UserPlus className="h-5 w-5 text-primary" /></div>
                  <div className="min-w-0">
                    <p className="font-medium">Free credentials for fresh signup</p>
                    <p className="text-sm text-muted-foreground mt-0.5">
                      Best when the deletion was <strong>intentional</strong> but the user wants back in as a brand-new account. Keeps the archived record (for history) and releases the phone/email so the user can register from scratch.
                    </p>
                  </div>
                </div>
              </button>
            </div>
          )}

          {mode === 'restore' && (
            <div className="space-y-4 py-2">
              <div className="bg-muted rounded-md p-3 text-sm space-y-1">
                <div><span className="text-muted-foreground">Original phone:</span> {active?.phone || <Badge variant="outline">none</Badge>}</div>
                <div><span className="text-muted-foreground">Original email:</span> {active?.email || <Badge variant="outline">none</Badge>}</div>
              </div>
              <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-900 dark:text-amber-200 flex gap-2">
                <AlertTriangle className="h-4 w-4 flex-shrink-0 mt-0.5" />
                <span>If the original email or phone is now used by another live account, the restore will fail. Use the override fields below to assign new ones in that case.</span>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <div>
                  <Label htmlFor="ov-email">Override email (optional)</Label>
                  <Input id="ov-email" placeholder="leave blank to use original" value={overrideEmail} onChange={(e) => setOverrideEmail(e.target.value)} />
                </div>
                <div>
                  <Label htmlFor="ov-phone">Override phone (optional)</Label>
                  <Input id="ov-phone" placeholder="leave blank to use original" value={overridePhone} onChange={(e) => setOverridePhone(e.target.value)} />
                </div>
              </div>
              <div>
                <Label htmlFor="reason">Reason (min 10 chars, audited)</Label>
                <Textarea id="reason" placeholder="Why is this account being restored?" value={reason} onChange={(e) => setReason(e.target.value)} rows={3} />
              </div>
            </div>
          )}

          {mode === 'free' && (
            <div className="space-y-4 py-2">
              <div className="bg-muted rounded-md p-3 text-sm space-y-1">
                <div><span className="text-muted-foreground">Phone to release:</span> {active?.phone || <Badge variant="outline">none</Badge>}</div>
                <div><span className="text-muted-foreground">Email to release:</span> {active?.email || <Badge variant="outline">none</Badge>}</div>
              </div>
              <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-900 dark:text-amber-200 flex gap-2">
                <AlertTriangle className="h-4 w-4 flex-shrink-0 mt-0.5" />
                <span>The archived record stays in place (for history and audit). After this, the user must complete a fresh signup themselves — their previous wallet, roles and history will NOT carry over.</span>
              </div>
              <div>
                <Label htmlFor="reason-free">Reason (min 10 chars, audited)</Label>
                <Textarea id="reason-free" placeholder="Why are these credentials being freed?" value={reason} onChange={(e) => setReason(e.target.value)} rows={3} />
              </div>
            </div>
          )}

          <DialogFooter>
            {mode === 'choose' ? (
              <Button variant="outline" onClick={() => setActive(null)}>Cancel</Button>
            ) : (
              <>
                <Button variant="ghost" onClick={() => setMode('choose')} disabled={submitting}>Back</Button>
                <Button variant="outline" onClick={() => setActive(null)} disabled={submitting}>Cancel</Button>
                {mode === 'restore' ? (
                  <Button onClick={submitRestore} disabled={submitting || reason.trim().length < 10}>
                    {submitting ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <ArchiveRestore className="h-4 w-4 mr-2" />}
                    Restore Account
                  </Button>
                ) : (
                  <Button onClick={submitFreeForResignup} disabled={submitting || reason.trim().length < 10}>
                    {submitting ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <UserPlus className="h-4 w-4 mr-2" />}
                    Free Credentials
                  </Button>
                )}
              </>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}