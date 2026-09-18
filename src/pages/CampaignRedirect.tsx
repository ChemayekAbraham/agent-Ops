import { useEffect, useState } from "react";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import {
  getVisitorId,
  createOrRefreshCampaignAttribution,
  purgeLegacyCampaignRef,
} from "@/lib/campaignAttribution";

type CampaignRedirectState =
  | { status: "loading" }
  | { status: "invalid"; message: string };

export default function CampaignRedirect() {
  const { slug = "", code = "" } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const isJoinAlias = location.pathname.startsWith("/join/");
  const [state, setState] = useState<CampaignRedirectState>({
    status: "loading",
  });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      // Sweep any legacy JSON attribution blob from older builds.
      purgeLegacyCampaignRef();
      if (!code) {
        setState({ status: "invalid", message: "Missing campaign code." });
        return;
      }
      // Fire click record (best-effort) + create/refresh server-side attribution.
      const visitorId = getVisitorId();
      const [clickRes, attrMeta, resolveRes] = await Promise.all([
        supabase.functions.invoke("campaign-click", {
          body: {
            short_code: code,
            visitor_id: visitorId,
            referrer:
              typeof document !== "undefined" ? document.referrer : null,
          },
        }),
        createOrRefreshCampaignAttribution(code),
        supabase.rpc("resolve_campaign_short_code", { p_short_code: code }),
      ]);
      if (cancelled) return;

      if (attrMeta?.status === "ok" && attrMeta.referring_agent_id) {
        try {
          localStorage.setItem("referral_agent_id", attrMeta.referring_agent_id);
          localStorage.setItem("become_role", "agent");
        } catch {
          // Server-side attribution token remains the source of truth.
        }
      }

      const meta = (resolveRes.data ?? null) as {
        link_id?: string;
        location_slug?: string;
        status?: string;
        campaign_status?: string;
      } | null;

      if (!meta || !meta.link_id) {
        setState({
          status: "invalid",
          message:
            "This campaign link is no longer active. Please contact a Welile agent for a valid registration link.",
        });
        return;
      }
      if (meta.status !== "active" || meta.campaign_status !== "active") {
        setState({
          status: "invalid",
          message:
            "This campaign link is no longer active. Please contact a Welile agent for a valid registration link.",
        });
        return;
      }

      // Canonical slug redirect if user hand-edited the location in the URL
      if (!isJoinAlias && meta.location_slug && meta.location_slug !== slug) {
        window.history.replaceState(
          {},
          "",
          `/c/${meta.location_slug}/${code}`,
        );
      }

      void clickRes; // click already recorded server-side (best effort)
      // Attribution is already persisted server-side; the opaque token lives
      // in a first-party cookie + localStorage recovery key
      // (welile_campaign_attribution / welile_campaign_attribution_token).
      // Redirect to a CLEAN /auth so no internal identifiers leak into the URL.
      // Auth.tsx restores attribution via restoreAttributionFromToken().
      // Campaign links are recruitment funnels — force the Sign Up tab and
      // preselect the agent role so the visitor lands ready to register as a
      // sub-agent of the referring agent.
      navigate(`/auth?signup=1&role=agent`, { replace: true });
    })();
    return () => {
      cancelled = true;
    };
  }, [code, isJoinAlias, slug, navigate]);

  if (state.status === "invalid") {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background p-6">
        <div className="max-w-md w-full rounded-lg border border-border bg-card p-6 text-center shadow-sm">
          <h1 className="text-lg font-semibold text-foreground mb-2">
            Link unavailable
          </h1>
          <p className="text-sm text-muted-foreground">{state.message}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-background">
      <div className="text-sm text-muted-foreground">
        Opening Welile registration…
      </div>
    </div>
  );
}