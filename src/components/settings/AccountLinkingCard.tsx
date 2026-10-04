import { useEffect, useState } from 'react';
import { Link2, Link2Off, Loader2, Mail, ShieldCheck } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { supabase } from '@/integrations/supabase/client';
import { useToast } from '@/hooks/use-toast';

type Identity = {
  id: string;
  provider: string;
  identity_data?: { email?: string; name?: string } | null;
  created_at?: string;
  last_sign_in_at?: string;
};

const PROVIDER_LABEL: Record<string, string> = {
  email: 'Email & password',
  google: 'Google',
  apple: 'Apple',
  phone: 'Phone',
};

export default function AccountLinkingCard() {
  const { toast } = useToast();
  const [identities, setIdentities] = useState<Identity[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    try {
      const { data, error } = await supabase.auth.getUserIdentities();
      if (error) throw error;
      setIdentities((data?.identities as Identity[]) ?? []);
    } catch (err) {
      console.error('[AccountLinking] load failed', err);
      setIdentities([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const linkGoogle = async () => {
    setBusy('link-google');
    try {
      const { error } = await supabase.auth.linkIdentity({
        provider: 'google',
        options: { redirectTo: `${window.location.origin}/settings?linked=google` },
      });
      if (error) throw error;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      toast({ title: 'Could not link Google', description: msg, variant: 'destructive' });
      setBusy(null);
    }
  };

  const unlink = async (identity: Identity) => {
    if (!identities || identities.length < 2) {
      toast({
        title: 'Cannot unlink last method',
        description: 'Add another sign-in method before removing this one.',
        variant: 'destructive',
      });
      return;
    }
    setBusy(`unlink-${identity.id}`);
    try {
      const { error } = await supabase.auth.unlinkIdentity(identity as never);
      if (error) throw error;
      toast({ title: 'Sign-in method removed', description: PROVIDER_LABEL[identity.provider] ?? identity.provider });
      await load();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      toast({ title: 'Could not unlink', description: msg, variant: 'destructive' });
    } finally {
      setBusy(null);
    }
  };

  const hasGoogle = identities?.some((i) => i.provider === 'google');

  return (
    <Card className="rounded-2xl">
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <ShieldCheck className="h-4 w-4 text-primary" /> Sign-in methods
        </CardTitle>
        <CardDescription>
          Link multiple ways to sign in to the same account. Google and email/password
          share the same account when linked here.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {loading ? (
          <div className="flex justify-center py-4">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <>
            {identities?.map((identity) => (
              <div key={identity.id} className="flex items-center justify-between gap-3 rounded-xl border p-3">
                <div className="min-w-0 flex items-center gap-3">
                  <div className="h-9 w-9 rounded-lg bg-muted flex items-center justify-center">
                    <Mail className="h-4 w-4 text-muted-foreground" />
                  </div>
                  <div className="min-w-0">
                    <p className="text-sm font-semibold">
                      {PROVIDER_LABEL[identity.provider] ?? identity.provider}
                    </p>
                    <p className="text-xs text-muted-foreground truncate">
                      {identity.identity_data?.email ?? '—'}
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <Badge variant="secondary" className="text-[10px]">Linked</Badge>
                  {identities.length > 1 && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => unlink(identity)}
                      disabled={busy === `unlink-${identity.id}`}
                      className="gap-1 text-destructive hover:text-destructive"
                    >
                      {busy === `unlink-${identity.id}` ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <Link2Off className="h-3.5 w-3.5" />
                      )}
                      Unlink
                    </Button>
                  )}
                </div>
              </div>
            ))}

            {!hasGoogle && (
              <Button
                onClick={linkGoogle}
                disabled={busy === 'link-google'}
                variant="outline"
                className="w-full rounded-xl gap-2"
              >
                {busy === 'link-google' ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Link2 className="h-4 w-4" />
                )}
                Link Google account
              </Button>
            )}

            {(!identities || identities.length === 0) && (
              <p className="text-xs text-muted-foreground text-center py-2">
                No sign-in methods on file.
              </p>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}