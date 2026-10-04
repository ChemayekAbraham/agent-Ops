import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * END-TO-END test for the campaign short-link → registration → sub-agent
 * attribution pipeline.
 *
 *   ┌──────────────────────────┐   ┌──────────────────────────┐
 *   │ Visitor opens            │ → │ createOrRefreshCampaign  │
 *   │ /c/{district}/{code}     │   │ Attribution → token      │
 *   └──────────────────────────┘   └───────────┬──────────────┘
 *                                              ▼
 *                                    Token persisted in
 *                                    cookie + localStorage
 *                                              │
 *                                              ▼
 *   ┌──────────────────────────┐   ┌──────────────────────────┐
 *   │ Auth.tsx boots           │ → │ restoreAttributionFrom   │
 *   │ (fresh reload / OTP)     │   │ Token → banner data      │
 *   └──────────────────────────┘   └───────────┬──────────────┘
 *                                              ▼
 *   ┌──────────────────────────┐   ┌──────────────────────────┐
 *   │ User submits sign-up →   │ → │ attachCampaignIfPresent  │
 *   │ session established      │   │ → complete_campaign_...  │
 *   └──────────────────────────┘   └───────────┬──────────────┘
 *                                              ▼
 *                                    agent_subagents row
 *                                    (parent = referring agent,
 *                                     child  = new user)
 *
 * Every RPC is stubbed with a small in-memory fake so the flow is
 * exercised deterministically without hitting the backend.
 */

const REFERRING_AGENT_ID = "agent-referrer-uuid";
const REFERRING_AGENT_NAME = "Jane Doe";
const CAMPAIGN_ID = "camp-uuid";
const LINK_ID = "link-uuid";
const SHORT_CODE = "KLA123";
const NEW_USER_ID = "new-user-uuid";

type Row = Record<string, any>;
const db: {
  attributions: Row[];
  subagents: Row[];
} = { attributions: [], subagents: [] };

let currentUserId: string | null = null;

function uuid() {
  return "tok-" + Math.random().toString(36).slice(2, 12);
}

const rpcHandlers: Record<string, (args: any) => any> = {
  resolve_campaign_short_code: ({ p_short_code }) => {
    if (p_short_code !== SHORT_CODE) return null;
    return {
      link_id: LINK_ID,
      campaign_id: CAMPAIGN_ID,
      campaign_name: "Kampala Field Recruitment",
      agent_id: REFERRING_AGENT_ID,
      location_slug: "kampala-central",
      location_display: "Kampala Central",
      district: "Kampala",
      selected_source: "agent_assisted",
      status: "active",
      campaign_status: "active",
    };
  },
  create_or_refresh_campaign_attribution: ({ p_short_code, p_visitor_id }) => {
    if (p_short_code !== SHORT_CODE)
      return { status: "invalid_short_code" };
    const token = uuid();
    db.attributions.push({
      token,
      short_code: p_short_code,
      visitor_id: p_visitor_id,
      campaign_id: CAMPAIGN_ID,
      referring_agent_id: REFERRING_AGENT_ID,
      locked: false,
      completed: false,
      user_id: null,
    });
    return {
      status: "ok",
      attribution_token: token,
      locked: false,
      campaign_link_id: LINK_ID,
      campaign_id: CAMPAIGN_ID,
      referring_agent_id: REFERRING_AGENT_ID,
      selected_source: "agent_assisted",
      canonical_slug: "kampala-central",
      short_code: SHORT_CODE,
    };
  },
  restore_campaign_attribution: ({ p_token }) => {
    const row = db.attributions.find((r) => r.token === p_token);
    if (!row) return { status: "invalid" };
    if (row.completed) return { status: "completed" };
    return {
      status: "ok",
      attribution_token: row.token,
      referring_agent_id: row.referring_agent_id,
      referring_agent_name: REFERRING_AGENT_NAME,
      campaign_id: row.campaign_id,
    };
  },
  complete_campaign_attribution: ({ p_token }) => {
    const row = db.attributions.find((r) => r.token === p_token);
    if (!row) return { status: "invalid" };
    if (!currentUserId) return { status: "no_session" };
    if (row.completed && row.user_id === currentUserId)
      return { status: "already_completed" };
    if (row.referring_agent_id === currentUserId)
      return { status: "self_referral_blocked" };
    row.completed = true;
    row.user_id = currentUserId;
    // Link as sub-agent (idempotent).
    const already = db.subagents.find(
      (s) =>
        s.parent_agent_id === row.referring_agent_id &&
        s.sub_agent_id === currentUserId,
    );
    if (!already) {
      db.subagents.push({
        parent_agent_id: row.referring_agent_id,
        sub_agent_id: currentUserId,
        campaign_id: row.campaign_id,
        created_at: new Date().toISOString(),
      });
    }
    return { status: "ok" };
  },
};

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    rpc: (name: string, args: any) => {
      const handler = rpcHandlers[name];
      if (!handler)
        return Promise.resolve({
          data: null,
          error: { message: `no handler for ${name}` },
        });
      try {
        return Promise.resolve({ data: handler(args), error: null });
      } catch (e: any) {
        return Promise.resolve({ data: null, error: { message: e.message } });
      }
    },
    functions: {
      invoke: () => Promise.resolve({ data: { ok: true }, error: null }),
    },
  },
}));

import {
  createOrRefreshCampaignAttribution,
  restoreAttributionFromToken,
  attachCampaignIfPresent,
  getStoredAttributionToken,
  clearCampaignRef,
} from "@/lib/campaignAttribution";

describe("campaign short link → sub-agent attribution E2E", () => {
  beforeEach(() => {
    localStorage.clear();
    document.cookie
      .split(";")
      .forEach(
        (c) =>
          (document.cookie = c.trim().split("=")[0] + "=; Max-Age=0; Path=/"),
      );
    db.attributions.length = 0;
    db.subagents.length = 0;
    currentUserId = null;
  });

  it("creates attribution, survives reload, and links new user as sub-agent of the referring agent", async () => {
    // 1) Visitor opens /c/kampala-central/KLA123
    const attr = await createOrRefreshCampaignAttribution(SHORT_CODE);
    expect(attr?.status).toBe("ok");
    expect(attr?.referring_agent_id).toBe(REFERRING_AGENT_ID);

    const token = getStoredAttributionToken();
    expect(token).toBeTruthy();
    expect(db.attributions).toHaveLength(1);

    // 2) Simulate reload → Auth.tsx restores via token.
    const restored = await restoreAttributionFromToken();
    expect(restored?.status).toBe("ok");
    expect((restored as any)?.referring_agent_name).toBe(REFERRING_AGENT_NAME);

    // 3) User signs up → session established.
    currentUserId = NEW_USER_ID;

    // 4) Post-auth hook fires.
    await attachCampaignIfPresent();

    // 5) Verify the DB linked the new user as a sub-agent of the referring agent.
    expect(db.subagents).toHaveLength(1);
    expect(db.subagents[0]).toMatchObject({
      parent_agent_id: REFERRING_AGENT_ID,
      sub_agent_id: NEW_USER_ID,
      campaign_id: CAMPAIGN_ID,
    });

    // 6) Attribution row is marked completed and local state cleared.
    expect(db.attributions[0].completed).toBe(true);
    expect(db.attributions[0].user_id).toBe(NEW_USER_ID);
    expect(getStoredAttributionToken()).toBeNull();
  });

  it("is idempotent — a second attach after completion does not create duplicate sub-agent rows", async () => {
    await createOrRefreshCampaignAttribution(SHORT_CODE);
    currentUserId = NEW_USER_ID;
    await attachCampaignIfPresent();

    // Simulate a duplicate post-auth hook firing (e.g., token still cached
    // somewhere) — restore token then reattach.
    const row = db.attributions[0];
    localStorage.setItem("welile_campaign_attribution_token", row.token);
    await attachCampaignIfPresent();

    expect(db.subagents).toHaveLength(1);
  });

  it("blocks self-referral: referring agent cannot become their own sub-agent", async () => {
    await createOrRefreshCampaignAttribution(SHORT_CODE);
    currentUserId = REFERRING_AGENT_ID;
    await attachCampaignIfPresent();

    expect(db.subagents).toHaveLength(0);
  });

  it("rejects invalid short codes with no attribution created", async () => {
    const attr = await createOrRefreshCampaignAttribution("BAD");
    expect(attr?.status).toBe("invalid_short_code");
    expect(db.attributions).toHaveLength(0);
    expect(getStoredAttributionToken()).toBeNull();
    clearCampaignRef();
  });
});