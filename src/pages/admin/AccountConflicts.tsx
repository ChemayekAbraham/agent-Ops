import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ArrowLeft, Search, Loader2, AlertTriangle, ShieldCheck, ArchiveRestore,
  UserPlus, AlertCircle, CheckCircle2,
} from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { useToast } from '@/hooks/use-toast';

interface ConflictRow {
  user_id: string;
  full_name: string | null;
  profile_phone: string | null;
  profile_email: string | null;
  profile_national_id: string | null;
  tenant_status: string | null;
  is_archived: boolean;
  auth_email: string | null;
  auth_phone: string | null;
  auth_deleted_at: string | null;
  auth_last_sign_in_at: string | null;
  match_reason: string | null;
}

type ResolveAction = 'restore' | 'free' | null;

export default function AccountConflictsPage() {
  const navigate = useNavigate();
  const { toast } = useToast();

  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [nationalId, setNationalId] = useState('');
  const [loading, setLoading] = useState(false);
  const [rows, setRows] = useState<ConflictRow[] | null>(null);

  const [active, setActive] = useState<ConflictRow | null>(null);
  const [action, setAction] = useState<ResolveAction>(null);
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const liveCount = (rows || []).filter(r => !r.is_archived).length;
  const archivedCount = (rows || []).filter(r => r.is_archived).length;
  const blockedBySignup = (rows || []).some(r => r.is_archived) && !liveCount;

  const search = async () => {
    if (!phone.trim() && !email.trim() && !nationalId.trim()) {
      toast({ title: 'Enter at least one value', description: 'Provide a phone, email, or national ID to search.', variant: 'destructive' });
      return;
    }
    setLoading(true);
    setRows(null);
    try {
      const { data, error } = await supabase.rpc('inspect_account_conflicts', {
        p_phone: phone.trim() || undefined,
        p_email: email.trim() || undefined,
        p_national_id: nationalId.trim() || undefined,
      });
      if (error) throw new Error(error.message);
      setRows((data as ConflictRow[]) || []);
    } catch (e: any) {
      toast({ title: 'Lookup failed', description: e?.message || 'Unknown error', variant: 'destructive' });
    } finally {
      setLoading(false);
    }
  };

  const openResolve = (row: ConflictRow, a: ResolveAction) => {
    setActive(row);
    setAction(a);
    setReason('');
  };

  const submitResolution = async () => {
    if (!active || !action) return;
    if (reason.trim().length < 10) {
      toast({ title: 'Reason too short', description: 'Provide at least 10 characters.', variant: 'destructive' });
      return;
    }
    setSubmitting(true);
    try {
      const fn = action === 'restore' ? 'restore-archived-account' : 'free-credentials-for-resignup';
      const { data, error } = await supabase.functions.invoke(fn, {
        body: { user_id: active.user_id, reason: reason.trim() },
      });
      if (error) throw new Error(error.message);
      if ((data as any)?.error) throw new Error((data as any).error);
      toast({
        title: action === 'restore' ? 'Account restored' : 'Credentials freed',
        description: action === 'restore'
          ? 'The user can sign in again with their original credentials.'
          : 'The phone/email is now free — the user can sign up fresh.',
      });
      setActive(null);
      setAction(null);
      await search();
    } catch (e: any) {
      toast({ title: 'Action failed', description: e?.message || 'Unknown error', variant: 'destructive' });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen bg-background p-4 md:p-8">
      <div className="max-w-5xl mx-auto space-y-6">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="icon" onClick={() => navigate(-1)}>
            <ArrowLeft className="h-5 w-5" />
          </Button>
          <div>
            <h1 className="text-2xl font-bold">Account Conflict Resolver</h1>
            <p className="text-sm text-muted-foreground">
              Find every profile and auth record colliding on a phone, email, or national ID, then safely restore or free credentials to unblock a fresh signup.
            </p>
          </div>
        </div>

        <Card>
          <CardHeader className="pb-3"><CardTitle className="text-base">Search</CardTitle></CardHeader>
          <CardContent className="space-y-3">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              <div>
                <Label htmlFor="phone">Phone</Label>
                <Input id="phone" placeholder="0781241542" value={phone} onChange={(e) => setPhone(e.target.value)} />
              </div>
              <div>
                <Label htmlFor="email">Email</Label>
                <Input id="email" placeholder="user@gmail.com" value={email} onChange={(e) => setEmail(e.target.value)} />
              </div>
              <div>
                <Label htmlFor="nid">National ID</Label>
                <Input id="nid" placeholder="CM12345…" value={nationalId} onChange={(e) => setNationalId(e.target.value)} />
              </div>
            </div>
            <div className="flex justify-end">
              <Button onClick={search} disabled={loading}>
                {loading ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Search className="h-4 w-4 mr-2" />}
                Inspect conflicts
              </Button>
            </div>
          </CardContent>
        </Card>

        {rows !== null && (
          <Card>
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between gap-3 flex-wrap">
                <CardTitle className="text-base">
                  {rows.length === 0
                    ? 'No conflicts — these credentials are free'
                    : `${rows.length} matching record${rows.length === 1 ? '' : 's'} (${liveCount} live, ${archivedCount} archived)`}
                </CardTitle>
                {rows.length === 0 ? (
                  <Badge variant="outline" className="border-green-500/40 text-green-600">
                    <CheckCircle2 className="h-3.5 w-3.5 mr-1" /> Fresh signup will succeed
                  </Badge>
                ) : blockedBySignup ? (
                  <Badge variant="outline" className="border-amber-500/40 text-amber-600">
                    <AlertTriangle className="h-3.5 w-3.5 mr-1" /> Fresh signup blocked by archived record
                  </Badge>
                ) : liveCount > 0 ? (
                  <Badge variant="outline" className="border-red-500/40 text-red-600">
                    <AlertCircle className="h-3.5 w-3.5 mr-1" /> A live account already holds these credentials
                  </Badge>
                ) : null}
              </div>
            </CardHeader>
            <CardContent>
              {rows.length === 0 ? (
                <p className="text-sm text-muted-foreground py-8 text-center">Nothing to resolve. The user can sign up with these credentials now.</p>
              ) : (
                <div className="divide-y">
                  {rows.map((r) => (
                    <div key={r.user_id} className="py-3 space-y-2">
                      <div className="flex items-start justify-between gap-3 flex-wrap">
                        <div className="min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            <p className="font-medium truncate">{r.full_name || '—'}</p>
                            {r.is_archived ? (
                              <Badge variant="outline" className="text-xs">Archived</Badge>
                            ) : (
                              <Badge className="text-xs">Live</Badge>
                            )}
                            {r.match_reason && (
                              <Badge variant="secondary" className="text-xs">matched on {r.match_reason}</Badge>
                            )}
                          </div>
                          <p className="text-xs text-muted-foreground mt-0.5">
                            phone: {r.profile_phone || '—'} · email: {r.profile_email || '—'}
                          </p>
                          <p className="text-[10px] text-muted-foreground font-mono">{r.user_id}</p>
                          {(r.auth_deleted_at || r.auth_last_sign_in_at) && (
                            <p className="text-[10px] text-muted-foreground mt-0.5">
                              {r.auth_deleted_at && <>deleted {new Date(r.auth_deleted_at).toLocaleString()} · </>}
                              {r.auth_last_sign_in_at && <>last signed in {new Date(r.auth_last_sign_in_at).toLocaleString()}</>}
                            </p>
                          )}
                        </div>
                        <div className="flex gap-2">
                          {r.is_archived ? (
                            <>
                              <Button size="sm" variant="outline" onClick={() => openResolve(r, 'restore')}>
                                <ArchiveRestore className="h-4 w-4 mr-1.5" /> Restore
                              </Button>
                              <Button size="sm" onClick={() => openResolve(r, 'free')}>
                                <UserPlus className="h-4 w-4 mr-1.5" /> Free for resignup
                              </Button>
                            </>
                          ) : (
                            <Badge variant="outline" className="text-xs flex items-center gap-1">
                              <ShieldCheck className="h-3.5 w-3.5" /> Live — cannot auto-resolve
                            </Badge>
                          )}
                        </div>
                      </div>
                    </div>
                  ))}
                  {liveCount > 0 && (
                    <div className="pt-3 mt-2 rounded-md border border-red-500/40 bg-red-500/10 p-3 text-xs text-red-700 dark:text-red-300 flex gap-2">
                      <AlertCircle className="h-4 w-4 flex-shrink-0 mt-0.5" />
                      <span>
                        A <strong>live</strong> account already owns these credentials. Do not free or override them automatically — verify the user's identity first, then either help them sign in to that account or have them use a different phone/email.
                      </span>
                    </div>
                  )}
                </div>
              )}
            </CardContent>
          </Card>
        )}
      </div>

      <Dialog open={!!active} onOpenChange={(o) => { if (!o) { setActive(null); setAction(null); } }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              {action === 'restore' ? <ArchiveRestore className="h-5 w-5" /> : <UserPlus className="h-5 w-5" />}
              {action === 'restore' ? 'Restore archived account' : 'Free credentials for fresh signup'}
            </DialogTitle>
            <DialogDescription>
              {action === 'restore' ? (
                <>This re-attaches the original email/phone to <strong>{active?.full_name?.replace(/^\[ARCHIVED\]\s*/i, '') || 'the account'}</strong> and lets the user sign in again with their existing history.</>
              ) : (
                <>This keeps the archived record in place (for history and audit) but releases the phone/email so the user can register a brand-new account.</>
              )}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3 py-2">
            <div className="bg-muted rounded-md p-3 text-sm space-y-1">
              <div><span className="text-muted-foreground">Phone:</span> {active?.profile_phone || <Badge variant="outline">none</Badge>}</div>
              <div><span className="text-muted-foreground">Email:</span> {active?.profile_email || <Badge variant="outline">none</Badge>}</div>
            </div>
            <div>
              <Label htmlFor="reason">Reason (min 10 chars, audited)</Label>
              <Textarea id="reason" placeholder="Why is this action being taken?" value={reason} onChange={(e) => setReason(e.target.value)} rows={3} />
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => { setActive(null); setAction(null); }} disabled={submitting}>Cancel</Button>
            <Button onClick={submitResolution} disabled={submitting || reason.trim().length < 10}>
              {submitting ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : action === 'restore' ? <ArchiveRestore className="h-4 w-4 mr-2" /> : <UserPlus className="h-4 w-4 mr-2" />}
              {action === 'restore' ? 'Restore Account' : 'Free Credentials'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}