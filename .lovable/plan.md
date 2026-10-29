# Agent KYC Command Center

## What will change
Turn `/agent-ops/agent-verification` into a focused KYC workspace for reviewing agents, checking identity connections and monitoring verification progress.

### Command overview
- A clear **Agent KYC Command Center** heading with refresh and last-updated state.
- Clickable totals for **Awaiting review**, **Verified**, **Sent back** and **Not started**, using actual server totals.
- A line graph of daily submissions, approvals and sent-back decisions, with 7-day and 30-day views and Kampala dates.
- A compact verification-status breakdown alongside the graph. Empty or unavailable data stays explicit; no invented trends or risk scores.

### Agent review queue
- Preserve name/phone search, active-agent filtering, status tabs and pagination.
- Use a scannable desktop table and compact mobile rows showing agent, district, status, ID source, identity-link count and submission age.
- Keep the oldest submissions first, as today.
- Make shared-ID connections visible without treating an approved parent-ID link as fraud.

### Identity connections and vetting
- Opening an agent keeps the existing review drawer: photos, contact confirmations, residence, GPS map, next of kin and decision history.
- Add **Agents linked to this National ID**, with the ID holder, linked agent names, contact details and verification statuses. Open a linked agent's review from that list and allow returning to the original agent.
- Match recorded own-ID and linked-ID relationships using the existing server normalization, not masked-number guesses.
- Keep National ID numbers masked in summaries. Preserve existing ID photo enlargement and previous-versus-current ID comparison.
- Preserve individual Approve and Send back actions and confirmation dialogs. No bulk approvals, automatic decisions or changes to verification requirements.

## Visual direction
A restrained operations desk: crisp typography, unframed page sections, strong table hierarchy, green verified states, amber review states and clear rejected states. Use existing semantic colors and controls, with balanced spacing and charts that remain legible on smaller screens.

## Technical details
- Keep all review reads and decisions in the existing agent-vetting hooks and helper layer.
- The current queue provides totals but no identity groups or complete historical series. Add narrowly scoped **read-only reporting RPCs** for aggregate trends, queue identity-link summaries and a selected agent's identity group.
- Reuse `is_agent_vetting_reviewer` for caller authorization, with explicit execution grants and `search_path = public`. Return only the fields needed by the workspace; never send full National ID values to the browser.
- Do not reuse `national_id_group_view()` for staff review: it intentionally returns the signed-in user's own group, not the selected agent's group.
- Derive graph history from recorded vetting events, not from the current 50-row queue or its latest status alone.
- Keep group reads paginated and overview reads aggregated; scope caches to the signed-in account and refresh them after existing decisions.
- No changes to payments, wallets, ledger entries, agent roles or verification enforcement. No publishing.

## Verification
- Test ID-group matching, own/linked-ID membership deduplication, masking and reviewer authorization.
- Test daily event aggregation, Kampala day boundaries and status totals against read-only source counts.
- Run the existing Agent Ops review tests to preserve photo review and decisions.
- Check search, filters, pagination, graph controls and linked-agent navigation in the browser at desktop and mobile sizes.
- Authenticated end-to-end verification depends on an available authorized session; report any unavailable checks rather than claiming a signed-out screen proves the workflow.