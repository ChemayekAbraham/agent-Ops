import { useState } from 'react';
import { KeyRound, Loader2, Copy, Check, ShieldAlert, Send, User } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { useToast } from '@/hooks/use-toast';

interface IssueResult {
  temp_password: string;
  login_url: string;
  delivered_via: string;
  delivery_error: string | null;
  user_name: string | null;
  masked_target: string | null;
  has_phone: boolean;
}

/**
 * CTO-only panel: look up a user by phone or email, issue a temporary
 * password (delivered by SMS), and force the user to reset it on next login.
 */
export function CTOPasswordResetPanel() {
  const { toast } = useToast();
  const [identifier, setIdentifier] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<IssueResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const handleIssue = async () => {
    const value = identifier.trim();
    if (!value) {
      setError('Enter a phone number or email address.');
      return;
    }
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const { data, error: fnError } = await supabase.functions.invoke('cto-issue-temp-password', {
        body: { identifier: value },
      });
      if (fnError) {
        // Try to surface the server-provided message.
        let msg = fnError.message || 'Failed to issue temporary password.';
        try {
          const ctx = (fnError as { context?: Response }).context;
          if (ctx && typeof ctx.json === 'function') {
            const j = await ctx.json();
            if (j?.error) msg = j.error;
          }
        } catch { /* ignore */ }
        setError(msg);
        return;
      }
      if (data?.error) {
        setError(data.error);
        return;
      }
      setResult(data as IssueResult);
      toast({ title: 'Temporary password issued', description: 'The user must reset it on next login.' });
    } catch (e) {
      setError((e as Error).message || 'Unexpected error.');
    } finally {
      setBusy(false);
    }
  };

  const copyPassword = async () => {
    if (!result?.temp_password) return;
    try {
      await navigator.clipboard.writeText(result.temp_password);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch { /* ignore */ }
  };

  const reset = () => {
    setResult(null);
    setError(null);
    setIdentifier('');
  };

  return (
    <div className="max-w-2xl mx-auto space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <KeyRound className="h-5 w-5 text-primary" />
            Reset User Password
          </CardTitle>
          <CardDescription>
            Look up a user by phone number or email, then issue a temporary password.
            It is sent to the user by SMS, and they are forced to set a new password on next login.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="cto-reset-identifier">Phone number or email</Label>
            <Input
              id="cto-reset-identifier"
              placeholder="e.g. 0780000000 or user@email.com"
              value={identifier}
              onChange={(e) => setIdentifier(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && !busy) handleIssue(); }}
              disabled={busy}
              autoComplete="off"
            />
          </div>

          {error && (
            <Alert variant="destructive">
              <ShieldAlert className="h-4 w-4" />
              <AlertTitle>Could not issue password</AlertTitle>
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}

          <div className="flex gap-2">
            <Button onClick={handleIssue} disabled={busy} className="gap-2">
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
              {busy ? 'Issuing…' : 'Issue temporary password'}
            </Button>
            {(result || error) && (
              <Button variant="outline" onClick={reset} disabled={busy}>Clear</Button>
            )}
          </div>
        </CardContent>
      </Card>

      {result && (
        <Card className="border-primary/40">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Check className="h-5 w-5 text-green-600" />
              Temporary password issued
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {result.user_name && (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <User className="h-4 w-4" />
                <span>{result.user_name}</span>
                {result.masked_target && <span>· {result.masked_target}</span>}
              </div>
            )}

            <div className="space-y-2">
              <Label>Temporary password</Label>
              <div className="flex items-center gap-2">
                <code className="flex-1 rounded-md bg-muted px-3 py-2 font-mono text-base break-all">
                  {result.temp_password}
                </code>
                <Button variant="outline" size="icon" onClick={copyPassword} title="Copy">
                  {copied ? <Check className="h-4 w-4 text-green-600" /> : <Copy className="h-4 w-4" />}
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                Sign-in link: <span className="font-medium">{result.login_url}</span>
              </p>
            </div>

            {result.delivered_via && result.delivered_via.startsWith('sms:') ? (
              <Alert>
                <Send className="h-4 w-4" />
                <AlertTitle>SMS sent</AlertTitle>
                <AlertDescription>
                  The temporary password was sent to {result.masked_target || 'the user'} by SMS.
                  They will be required to set a new password immediately after logging in.
                </AlertDescription>
              </Alert>
            ) : (
              <Alert variant="destructive">
                <ShieldAlert className="h-4 w-4" />
                <AlertTitle>SMS not delivered</AlertTitle>
                <AlertDescription>
                  {result.has_phone
                    ? `We could not send the SMS${result.delivery_error ? ` (${result.delivery_error})` : ''}. Share the temporary password with the user securely using the copy button above.`
                    : 'This user has no phone number on file. Share the temporary password with the user securely using the copy button above.'}
                </AlertDescription>
              </Alert>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

export default CTOPasswordResetPanel;
