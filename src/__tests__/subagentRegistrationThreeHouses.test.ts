import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

/**
 * Rule under test: an agent earns the sub-agent registration bonus ONLY once
 * their verified sub-agent has listed >= 3 valid (non-rejected) houses.
 *
 * The rule is enforced entirely in Postgres (functions + triggers) in
 * migration 20260708084132. This is a source-of-truth guard: it reads the
 * migration SQL and asserts the enforcement primitives are present and cannot
 * silently regress.
 */

const root = resolve(__dirname, "..", "..");
const MIGRATION =
  "supabase/migrations/20260708084132_d75af1f6-28c6-495c-be5e-be009aa04c1e.sql";
const sql = readFileSync(resolve(root, MIGRATION), "utf8");
const norm = sql.replace(/\s+/g, " ");

describe("sub-agent registration bonus: >= 3 house listings rule", () => {
  it("defines a non-rejected listing counter", () => {
    expect(norm).toMatch(
      /CREATE OR REPLACE FUNCTION public\.subagent_listing_count/i,
    );
    expect(norm).toMatch(/FROM public\.house_listings WHERE agent_id = p_sub_agent_id/i);
    expect(norm).toMatch(/COALESCE\(status, ''\) <> 'rejected'/i);
  });

  it("gates the payout behind the >= 3 threshold (returns early below 3)", () => {
    expect(norm).toMatch(
      /CREATE OR REPLACE FUNCTION public\.try_award_subagent_registration_bonus/i,
    );
    // The gate: fewer than 3 listings -> do not pay
    expect(norm).toMatch(
      /IF public\.subagent_listing_count\(p_sub_agent_id\) < 3 THEN RETURN;/i,
    );
  });

  it("only pays verified sub-agents' parent agents", () => {
    expect(norm).toMatch(/status = 'verified'/i);
    expect(norm).toMatch(/parent_agent_id IS NOT NULL/i);
  });

  it("stays idempotent via credit_agent_event_bonus keyed on the sub-agent", () => {
    expect(norm).toMatch(
      /credit_agent_event_bonus\( r\.parent_agent_id, 'subagent_registration', NULL::uuid, p_sub_agent_id::text \)/i,
    );
  });

  it("does NOT pay eagerly on verification alone (attempt is gated)", () => {
    // The verify trigger must call the GATED helper, never credit directly.
    expect(norm).toMatch(
      /CREATE OR REPLACE FUNCTION public\.award_subagent_registration_bonus/i,
    );
    expect(norm).toMatch(
      /PERFORM public\.try_award_subagent_registration_bonus\(NEW\.sub_agent_id\)/i,
    );
  });

  it("retroactively pays when a later listing crosses the 3rd house", () => {
    expect(norm).toMatch(
      /CREATE OR REPLACE FUNCTION public\.award_subagent_bonus_on_listing/i,
    );
    expect(norm).toMatch(
      /CREATE TRIGGER trg_award_subagent_bonus_on_listing AFTER INSERT OR UPDATE OF status ON public\.house_listings/i,
    );
    expect(norm).toMatch(
      /PERFORM public\.try_award_subagent_registration_bonus\(NEW\.agent_id\)/i,
    );
  });
});
