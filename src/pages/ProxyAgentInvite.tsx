import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import ReactMarkdown from 'react-markdown';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { useMyProxyAgentStatus } from '@/hooks/useProxyAgentApproval';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import { ScrollArea } from '@/components/ui/scroll-area';
import { AlertTriangle, CheckCircle2, Clock, FileText, Loader2 } from 'lucide-react';

const STORAGE_KEY = 'pendingProxyInvite';

interface Agreement {
  id: string;
  version_code: string;
  body_md: string;
  already_accepted: boolean;
}

export default function ProxyAgentInvite() {
  const { code = '' } = useParams<{ code: string }>();
  const navigate = useNavigate();
  const { user, loading: authLoading } = useAuth();
  const myAccessQ = useMyProxyAgentStatus(user?.id ?? null);
  const myAccess = myAccessQ.data?.status ?? 'none';

  const [agreement, setAgreement] = useState<Agreement | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [nin, setNin] = useState('');
  const [fullName, setFullName] = useState('');
  const [phone, setPhone] = useState('');
  // 'pending' | 'approved' | ... — server-side proxy access identifier after acceptance
  const [approvalStatus, setApprovalStatus] = useState<string | null>(null);
  const [agreed, setAgreed] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [accepted, setAccepted] = useState(false);
  // Whether the accepted invite actually attached a lead partner.
  // Null until an acceptance response is seen.
  const [leadAttached, setLeadAttached] = useState<boolean | null>(null);
  // Bumps the load effect so the Retry button can re-run current_proxy_agreement.
  const [retryCount, setRetryCount] = useState(0);

  // Remember the invite code so the user can resume after signing in.
  useEffect(() => {
    if (!code) return;
    try {
      localStorage.setItem(STORAGE_KEY, code);
    } catch {
      /* storage unavailable — ignore */
    }
  }, [code]);


  useEffect(() => {
    if (authLoading || !user) return;
    let cancelled = false;
    let timedOut = false;
    let loadTimeout: ReturnType<typeof setTimeout> | null = null;

    const fetchAgreement = async () => {
      setLoading(true);
      setError(null);

      // 10-second watchdog: if the RPC hangs without rejecting, force the spinner off
      // and surface a retryable error. This mirrors the 8-second init watchdog in useAuth.
      loadTimeout = setTimeout(() => {
        if (!cancelled) {
          timedOut = true;
          setLoading(false);
          setError('Could not load the agreement. Check your connection and try again.');
        }
      }, 10000);

      // Prefill identity fields from the signed-in profile so the applicant only confirms them.
      supabase
        .from('profiles')
        .select('full_name, phone')
        .eq('id', user.id)
        .maybeSingle()
        .then(({ data: prof }) => {
          if (cancelled || !prof) return;
          setFullName((prev) => prev || (prof.full_name ?? ''));
          setPhone((prev) => prev || (prof.phone ?? ''));
        });

      const { data, error: rpcError } = await supabase.rpc('current_proxy_agreement');
      if (loadTimeout) {
        clearTimeout(loadTimeout);
        loadTimeout = null;
      }
      if (cancelled || timedOut) return;

      if (rpcError) {
        setError(rpcError.message);
      } else {
        const row = Array.isArray(data) ? data[0] : data;
        if (row) {
          setAgreement(row as unknown as Agreement);
        } else {
          setError('No active proxy agreement is available right now.');
        }
      }
      setLoading(false);
    };

    fetchAgreement();

    return () => {
      cancelled = true;
      if (loadTimeout) clearTimeout(loadTimeout);
    };
  }, [authLoading, user, retryCount]);

  const canAccept = useMemo(
    () =>
      agreed &&
      nin.trim().length >= 8 &&
      fullName.trim().length >= 3 &&
      phone.replace(/\D/g, '').length >= 9 &&
      !submitting,
    [agreed, nin, fullName, phone, submitting],
  );

  const handleAccept = async () => {
    setSubmitting(true);
    setError(null);
    let submitTimedOut = false;
    let submitTimeout: ReturnType<typeof setTimeout> | null = null;

    // 10-second watchdog for the acceptance RPC, matching the useAuth init timeout pattern.
    submitTimeout = setTimeout(() => {
      submitTimedOut = true;
      setSubmitting(false);
      setError('The request timed out. Your acceptance may not have been recorded — reload this page to check.');
    }, 10000);

    const { data, error: rpcError } = await supabase.rpc('accept_proxy_agreement', {
      p_code: code,
      p_nin: nin.trim(),
      p_full_name: fullName.trim(),
      p_phone: phone.trim(),
    } as never);

    if (submitTimeout) {
      clearTimeout(submitTimeout);
      submitTimeout = null;
    }

    // If the watchdog fired, the RPC result is stale/unknown — do not overwrite the timeout message.
    if (submitTimedOut) return;

    setSubmitting(false);

    if (rpcError) {
      setError(rpcError.message);
      // Surface the backend failure verbatim, prefixed for context, and stay
      // on the form: no success screen, no redirect.
      setError(`Could not accept: ${rpcError.message}`);
      return;
    }

    const row: any = Array.isArray(data) ? data[0] : data;
    if (row?.status === 'accepted') {
      // An accepted agreement without a lead attachment is still a success,
      // but the proxy must be told the link did not happen.
      setLeadAttached(row?.lead_attached === true);
      setApprovalStatus(typeof row?.approval_status === 'string' ? row.approval_status : 'pending');
      try {
        localStorage.removeItem(STORAGE_KEY);
      } catch {
        /* ignore */
      }
      setAccepted(true);
      return;
    }

    if (row?.status === 'error') {
      setError(`Could not accept: ${row?.message || 'the agreement could not be accepted.'}`);
      return;
    }

    setError(row?.message || row?.status || 'Could not accept the agreement.');
  };

  if (authLoading) return null;

  if (!user) {
    return (
      <div className="min-h-screen bg-background px-4 py-8">
        <div className="mx-auto w-full max-w-2xl">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <FileText className="h-4 w-4 text-primary" />
                Proxy agent agreement
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <p className="text-sm text-muted-foreground">
                You've been invited to join Welile as a proxy agent. Sign in or create an account, then accept the proxy agent agreement.
              </p>
              <div className="flex flex-col gap-2">
                <Button asChild variant="outline" className="w-full justify-start">
                  <Link to={`/auth?redirect=${encodeURIComponent(`/pa/${code}`)}`}>
                    I already have a Welile account
                  </Link>
                </Button>
                <Button asChild className="w-full justify-start">
                  <Link to={`/auth?signup=1&role=agent&redirect=${encodeURIComponent(`/pa/${code}`)}&signup_source=proxy-invite`}>
                    Create an account
                  </Link>
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background px-4 py-8">
      <div className="mx-auto w-full max-w-2xl space-y-4">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <FileText className="h-4 w-4 text-primary" />
              Proxy agent agreement
              {agreement?.version_code && (
                <span className="text-xs font-normal text-muted-foreground">
                  Version {agreement.version_code}
                </span>
              )}
            </CardTitle>
          </CardHeader>

          <CardContent className="space-y-4">
            {loading && (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                Loading agreement…
              </div>
            )}

            {error && (
              <div className="space-y-2">
                <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                  <span className="break-words">{error}</span>
                </div>
                {error === 'Could not load the agreement. Check your connection and try again.' && !loading && (
                  <Button
                    onClick={() => setRetryCount((c) => c + 1)}
                    variant="outline"
                    className="w-full"
                  >
                    Retry
                  </Button>
                )}
              </div>
            )}

            {accepted ? (
              <div className="space-y-3">
                {approvalStatus === 'approved' ? (
                  <div className="flex items-start gap-2 rounded-md border border-primary/30 bg-primary/10 p-3 text-sm">
                    <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
                    <span>You're approved. Open your Proxy Agent Command Center.</span>
                  </div>
                ) : (
                  <div className="space-y-2">
                    <div className="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
                      <Clock className="mt-0.5 h-4 w-4 shrink-0" />
                      <span className="break-words">
                        Agreement accepted — your application is now <strong>pending approval</strong>. You'll appear in
                        the Partner Ops proxy agent list. Once approved you can access the Proxy Agent Command Center.
                      </span>
                    </div>
                    <div className="rounded-md border bg-muted/40 p-3 text-xs space-y-1">
                      <p><span className="text-muted-foreground">Name:</span> {fullName.trim()}</p>
                      <p><span className="text-muted-foreground">Phone:</span> {phone.trim()}</p>
                      <p><span className="text-muted-foreground">National ID:</span> {nin.trim()}</p>
                    </div>
                  </div>
                )}
                {leadAttached === false && (
                  <div className="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-800">
                    <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                    <span className="break-words">
                      Accepted, but no lead was attached — the invite code may have expired or reached its limit.
                    </span>
                  </div>
                )}
                <Button
                  onClick={() =>
                    navigate(approvalStatus === 'approved' ? '/agent/proxy-agents' : '/', { replace: true })
                  }
                  className="w-full"
                >
                  {approvalStatus === 'approved' ? 'Open Proxy Agent Command Center' : 'Back to home'}
                </Button>
              </div>
            ) : agreement?.already_accepted ? (
              <div className="space-y-3">
                <p className="text-sm">You have already accepted this month's agreement</p>
                {myAccess === 'approved' ? (
                  <>
                    <div className="flex items-start gap-2 rounded-md border border-primary/30 bg-primary/10 p-3 text-sm">
                      <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
                      <span>Your proxy agent access is approved.</span>
                    </div>
                    <Button className="w-full" onClick={() => navigate('/agent/proxy-agents')}>
                      Open Proxy Agent Command Center
                    </Button>
                  </>
                ) : (
                  <div className="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
                    <Clock className="mt-0.5 h-4 w-4 shrink-0" />
                    <span className="break-words">
                      {myAccess === 'rejected'
                        ? 'Your proxy agent application was not approved.'
                        : 'Your application is pending Partner Ops approval. You will get proxy agent access once approved.'}
                      {myAccessQ.data?.review_notes ? ` Note: ${myAccessQ.data.review_notes}` : ''}
                    </span>
                  </div>
                )}
                <Link to="/pa/record" className="text-sm text-primary underline">
                  Go to record a promissory note
                </Link>
              </div>
            ) : agreement ? (
              <>
                <ScrollArea className="h-[45vh] rounded-md border p-4">
                  <div className="prose prose-sm max-w-none dark:prose-invert text-sm leading-relaxed">
                    <ReactMarkdown>{agreement.body_md || ''}</ReactMarkdown>
                  </div>
                </ScrollArea>

                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="space-y-1.5">
                    <Label htmlFor="proxy-name" className="text-sm">Full name</Label>
                    <Input
                      id="proxy-name"
                      value={fullName}
                      onChange={(e) => setFullName(e.target.value)}
                      placeholder="Your name as on your National ID"
                      autoComplete="name"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="proxy-phone" className="text-sm">Phone number</Label>
                    <Input
                      id="proxy-phone"
                      value={phone}
                      onChange={(e) => setPhone(e.target.value)}
                      placeholder="07XXXXXXXX"
                      inputMode="tel"
                      autoComplete="tel"
                    />
                  </div>
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="proxy-nin" className="text-sm">
                    National ID number
                  </Label>
                  <Input
                    id="proxy-nin"
                    value={nin}
                    onChange={(e) => setNin(e.target.value)}
                    placeholder="Enter your National ID number"
                    autoComplete="off"
                  />
                  <p className="text-xs text-muted-foreground">
                    Required to verify your identity for payments.
                  </p>
                </div>

                <label className="flex cursor-pointer items-start gap-2.5 rounded-md p-2 text-sm hover:bg-muted/40">
                  <Checkbox
                    checked={agreed}
                    onCheckedChange={(c) => setAgreed(c === true)}
                    className="mt-0.5"
                  />
                  <span>
                    I have read and accept this agreement, and confirm the name, phone number and National ID above are mine.
                  </span>
                </label>

                <Button onClick={handleAccept} disabled={!canAccept} className="w-full">
                  {submitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                  Accept &amp; submit for approval
                </Button>
                <p className="text-center text-xs text-muted-foreground">
                  Partner Ops reviews every application before proxy agent access is granted.
                </p>
              </>
            ) : null}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
