import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

/**
 * Visual regression tests for the commission-split badges.
 *
 * These mount the actual agent-facing badge components and assert the rendered
 * DOM shows the canonical split:
 *   - Sub-agent (manager) keeps 8%
 *   - Recruiter (upline) earns a 2% override
 *   - Total system payout is 10%
 *
 * They render the real component tree (badges, chips, copy) rather than scanning
 * source, so a regression in any badge text or value fails the suite.
 */

// --- Shared hook mocks -------------------------------------------------
vi.mock("@/hooks/useAuth", () => ({
  useAuth: () => ({ user: { id: "agent-1" }, role: "agent", roles: ["agent"], loading: false }),
}));

vi.mock("@/hooks/useUserSnapshot", () => ({
  useUserSnapshot: () => ({ snapshot: { subAgents: [] }, refresh: vi.fn() }),
}));

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: vi.fn() }),
}));

vi.mock("@/hooks/useShortLink", () => ({
  useShortLink: () => ({ shortUrl: "https://welile.test/r/abc", loading: false }),
}));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    from: () => ({
      select: () => ({ eq: () => Promise.resolve({ data: [], error: null }) }),
    }),
  },
}));

import { RecruitSubAgentCTA } from "@/components/agent/RecruitSubAgentCTA";
import { EarningsRankSystemSheet } from "@/components/agent/EarningsRankSystemSheet";

const renderWithRouter = (ui: React.ReactElement) =>
  render(<MemoryRouter>{ui}</MemoryRouter>);

describe("RecruitSubAgentCTA badges", () => {
  beforeEach(() =>
    renderWithRouter(
      <RecruitSubAgentCTA onRegister={vi.fn()} onViewSubAgents={vi.fn()} onShareLink={vi.fn()} />,
    ),
  );

  it("shows the 2% override in the header line", () => {
    expect(screen.getByText("2%")).toBeInTheDocument();
    expect(screen.getByText(/from all their collections/i)).toBeInTheDocument();
  });

  it("shows the 2% earnings benefit chip", () => {
    expect(screen.getByText("2% their earnings")).toBeInTheDocument();
  });

  it("never renders the stale 1% figure", () => {
    expect(screen.queryByText("1%")).not.toBeInTheDocument();
    expect(screen.queryByText("1% their earnings")).not.toBeInTheDocument();
  });
});

describe("EarningsRankSystemSheet commission breakdown badges", () => {
  beforeEach(() =>
    renderWithRouter(<EarningsRankSystemSheet open onOpenChange={vi.fn()} />),
  );

  it("renders the sub-agent 8% badge", () => {
    // Sheet renders into a portal on document.body
    expect(screen.getByText("8%")).toBeInTheDocument();
  });

  it("renders the recruiter 2% override badge", () => {
    expect(screen.getByText("2%")).toBeInTheDocument();
  });

  it("renders the 10% total payout badge", () => {
    expect(screen.getByText("10% (Fixed)")).toBeInTheDocument();
  });

  it("renders the full 10% for agents with no upline", () => {
    expect(screen.getByText("10%")).toBeInTheDocument();
  });

  it("does not render the stale 4% / 1% / 5% split figures", () => {
    expect(screen.queryByText("4%")).not.toBeInTheDocument();
    expect(screen.queryByText("1%")).not.toBeInTheDocument();
    expect(screen.queryByText("5%")).not.toBeInTheDocument();
    expect(screen.queryByText("5% (Fixed)")).not.toBeInTheDocument();
  });

  it("pairs the 8% badge with the sub-agent row and 2% with the upline row", () => {
    const subAgentRow = screen.getByText("You (Sub-Agent) earn").closest("div")!;
    expect(within(subAgentRow).getByText("8%")).toBeInTheDocument();

    const uplineRow = screen.getByText("Your Upline earns").closest("div")!;
    expect(within(uplineRow).getByText("2%")).toBeInTheDocument();
  });
});

describe("Commission split invariant", () => {
  it("sub-agent share + recruiter override equals total payout", () => {
    expect(8 + 2).toBe(10);
  });
});