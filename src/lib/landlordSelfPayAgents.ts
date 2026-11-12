// Browser re-export of the server list of direct-pay agents. The server
// still decides; this only skips asking such agents for their location.
export { canSelfPayLandlords, LANDLORD_SELF_PAY_AGENT_IDS } from '../../supabase/functions/_shared/landlordSelfPayAgents';
