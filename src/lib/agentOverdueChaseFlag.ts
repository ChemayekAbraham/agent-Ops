/**
 * Kill-switch + cadence flags for agent overdue field-chase.
 *
 * Product: agent_overdue_field_chase.enabled
 * Faith urgency default: ENABLED. Flip to false and redeploy to silence.
 *
 * SMS re-fire every 2h workday is STUBBED OFF until Collections wires sender.
 */
export const AGENT_OVERDUE_CHASE_ENABLED = true;

/** In-app re-nudge interval while book is <100% DONE (ms). */
export const AGENT_OVERDUE_CHASE_NUDGE_MS = 15 * 60 * 1000;

/**
 * SMS re-fire cadence stub. Keep false in this PR — implement sender later.
 * When true, a client tick would invoke the (not-yet-built) edge function.
 */
export const AGENT_OVERDUE_CHASE_SMS_REFIRING_ENABLED = false;
export const AGENT_OVERDUE_CHASE_SMS_INTERVAL_MS = 2 * 60 * 60 * 1000;
