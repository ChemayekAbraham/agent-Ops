import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const source = readFileSync(
  resolve(__dirname, "..", "..", "supabase", "functions", "tenant-self-onboarding", "index.ts"),
  "utf8",
);

describe("tenant self-onboarding referral assignment", () => {
  it("resolves attribution from the authenticated tenant profile", () => {
    expect(source).toContain('.select("referrer_id")');
    expect(source).toContain('.eq("id", userId)');
  });

  it("requires a non-frozen referrer with an enabled agent role", () => {
    expect(source).toContain('candidateReferrerId !== userId');
    expect(source).toContain('referrerProfile.is_frozen !== true');
    expect(source).toContain('.eq("role", "agent").eq("enabled", true)');
  });

  it("assigns only the server-resolved referrer to the Rent Request", () => {
    expect(source).toContain("agent_id: referringAgentId");
    expect(source).not.toMatch(/agent_id:\s*body\./);
    expect(source).not.toContain("agent_id: null");
  });

  it("does not create a sub-agent relationship", () => {
    expect(source).not.toContain('.from("agent_subagents")');
  });
});