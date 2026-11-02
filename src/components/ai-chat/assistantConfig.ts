/** The assistant's display name — change it here only. */
export const ASSISTANT_NAME = 'Clara';
export const HELP_URL = 'https://help.welileapp.com';
export const WHATSAPP_URL = 'https://wa.me/256777607640';

export const AGENT_DATA_CHIPS = [
  'How much did I collect this week?',
  'Which tenants are behind?',
  'How is my team doing?',
  "What's my wallet balance?",
  'How much landlord float can I spend?',
];
export const HOW_TO_CHIPS = [
  'How do I earn commission?',
  'How do I renew a tenant?',
  'How do I invite a sub-agent?',
  'How do I reset my password?',
];
export const EXPLAINER_CHIPS = ['What is a Rent Plan?', 'How is a Rent Plan cost worked out?'];

/** Agent-data first for agents, otherwise how-to and explainers first. */
export function orderedChips(agentFirst: boolean): string[] {
  return agentFirst ? [...AGENT_DATA_CHIPS, ...HOW_TO_CHIPS, ...EXPLAINER_CHIPS] : [...HOW_TO_CHIPS, ...EXPLAINER_CHIPS, ...AGENT_DATA_CHIPS];
}
export const VISIBLE_CHIPS = 6;
