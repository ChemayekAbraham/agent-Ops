/**
 * Kill-switch + cadence flags for agent overdue field-chase.
 *
 * Product: agent_overdue_field_chase.enabled
 * Faith urgency default: ENABLED. Flip to false and redeploy to silence.
 *
 * SMS re-fire every 2h workday is STUBBED OFF until Collections wires sender.
 */
export const AGENT_OVERDUE_CHASE_ENABLED = true;

/**
 * Hard modal from this component. OFF on the rebased branch (2026-09-28):
 * `lovable` already ships AgentOverdueCallDrive (8db2f24d, live on
 * welileapp.com), a full-stop overdue call modal on the same dashboard.
 * Two non-dismissable modals stacked on every app open is worse than one, so
 * this component contributes the banner, % Called, list sheet and touch
 * tracking only. Flip to true (and unmount AgentOverdueCallDrive) if the
 * product decision is to use this modal instead.
 */
export const AGENT_OVERDUE_CHASE_MODAL_ENABLED = false;

/** In-app re-nudge interval while book is <100% DONE (ms). */
export const AGENT_OVERDUE_CHASE_NUDGE_MS = 15 * 60 * 1000;

/**
 * SMS re-fire cadence stub. Keep false in this PR — implement sender later.
 * When true, a client tick would invoke the (not-yet-built) edge function.
 */
export const AGENT_OVERDUE_CHASE_SMS_REFIRING_ENABLED = false;
export const AGENT_OVERDUE_CHASE_SMS_INTERVAL_MS = 2 * 60 * 60 * 1000;
