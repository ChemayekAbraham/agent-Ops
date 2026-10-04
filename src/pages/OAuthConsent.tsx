import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Loader2, ShieldCheck } from "lucide-react";
import WelileLogo from "@/components/WelileLogo";

// `supabase.auth.oauth` is a beta namespace not yet in the generated types.
type OAuthApi = {
  getAuthorizationDetails: (id: string) => Promise<{ data: any; error: { message: string } | null }>;
  approveAuthorization: (id: string) => Promise<{ data: any; error: { message: string } | null }>;
  denyAuthorization: (id: string) => Promise<{ data: any; error: { message: string } | null }>;
};

function oauthApi(): OAuthApi {
  return (supabase.auth as unknown as { oauth: OAuthApi }).oauth;
}

const POST_AUTH_REDIRECT_KEY = "welile_post_auth_redirect";

function setPostAuthRedirect(path: string) {
  try {
    sessionStorage.setItem(POST_AUTH_REDIRECT_KEY, path);
  } catch { /* non-critical */ }
}


export default function OAuthConsent() {
  const [params] = useSearchParams();
  const authorizationId = params.get("authorization_id") ?? "";
  const [details, setDetails] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let active = true;
    (async () => {
      if (!authorizationId) return setError("Missing authorization_id");
      const { data: sess } = await supabase.auth.getSession();
      if (!sess.session) {
        // Preserve the FULL consent URL so auth returns the user here.
        // We also stash it in sessionStorage because Google/Apple OAuth
        // drops query params after the provider round-trip.
        const next = window.location.pathname + window.location.search;
        setPostAuthRedirect(next);
        window.location.href = "/auth?redirect=" + encodeURIComponent(next);
        return;
      }

      const { data, error } = await oauthApi().getAuthorizationDetails(authorizationId);
      if (!active) return;
      if (error) return setError(error.message);
      const immediate = data?.redirect_url ?? data?.redirect_to;
      if (immediate && !data?.client) {
        window.location.href = immediate;
        return;
      }
      setDetails(data);
    })();
    return () => {
      active = false;
    };
  }, [authorizationId]);

  async function decide(approve: boolean) {
    setBusy(true);
    const api = oauthApi();
    const { data, error } = approve
      ? await api.approveAuthorization(authorizationId)
      : await api.denyAuthorization(authorizationId);
    if (error) {
      setBusy(false);
      return setError(error.message);
    }
    const target = data?.redirect_url ?? data?.redirect_to;
    if (!target) {
      setBusy(false);
      return setError("No redirect returned by the authorization server.");
    }
    window.location.href = target;
  }

  const clientName = details?.client?.name ?? "an app";

  return (
    <main className="min-h-screen flex items-center justify-center bg-background p-4">
      <Card className="w-full max-w-md">
        <CardContent className="p-6 space-y-5">
          <div className="flex justify-center">
            <WelileLogo />
          </div>
          {error ? (
            <p className="text-sm text-destructive text-center">
              Could not load this authorization request: {error}
            </p>
          ) : !details ? (
            <div className="flex items-center justify-center gap-2 text-muted-foreground py-6">
              <Loader2 className="h-5 w-5 animate-spin" /> Loading…
            </div>
          ) : (
            <>
              <div className="text-center space-y-2">
                <div className="w-12 h-12 rounded-full bg-primary/10 flex items-center justify-center mx-auto">
                  <ShieldCheck className="h-6 w-6 text-primary" />
                </div>
                <h1 className="text-lg font-bold">Connect {clientName} to your account</h1>
                <p className="text-sm text-muted-foreground">
                  This lets {clientName} read your Welile profile, wallet balance, and recent
                  transactions on your behalf. You can revoke access at any time.
                </p>
              </div>
              <div className="flex gap-3">
                <Button variant="outline" className="flex-1" disabled={busy} onClick={() => decide(false)}>
                  Deny
                </Button>
                <Button className="flex-1" disabled={busy} onClick={() => decide(true)}>
                  {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : "Approve"}
                </Button>
              </div>
            </>
          )}
        </CardContent>
      </Card>
    </main>
  );
}