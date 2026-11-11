/** The assistant's display name — change it here only. */
export const ASSISTANT_NAME = 'Nexa';
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
  'What is league rank?',
];
export const EXPLAINER_CHIPS = ['What is a Rent Plan?', 'How is a Rent Plan cost worked out?'];

export const PARTNER_DATA_CHIPS = [
  'How are my portfolios doing?',
  'How much have I earned?',
  'When is my next payout?',
  'Which portfolios mature soon?',
  "What's my wallet balance?",
  'Show my last withdrawals',
  'Did my top-up go through?',
  'Where is my renewal?',
  'Show my contract details',
  'Which of my portfolios compound?',
];
export const PARTNER_HOW_TO_CHIPS = ['How do I top up a portfolio?', 'How do I renew a portfolio?', 'How do I withdraw my Rent profit share?'];
export const PARTNER_EXPLAINER_CHIPS = ['What is compounding?', 'How are Rent profit share calculated?'];
export const PARTNER_GREETING = 'Ask me about your portfolios, Rent profit share, top-ups, renewals or withdrawals.';
export const DEFAULT_GREETING = 'How can i help you!';

export function isPartnerPath(pathname: string): boolean {
  return pathname.startsWith('/dashboard/funder');
}
export function partnerChips(): string[] {
  return [...PARTNER_DATA_CHIPS, ...PARTNER_HOW_TO_CHIPS, ...PARTNER_EXPLAINER_CHIPS];
}

/** Agent-data first for agents, otherwise how-to and explainers first. */
export function orderedChips(agentFirst: boolean): string[] {
  return agentFirst ? [...AGENT_DATA_CHIPS, ...HOW_TO_CHIPS, ...EXPLAINER_CHIPS] : [...HOW_TO_CHIPS, ...EXPLAINER_CHIPS, ...AGENT_DATA_CHIPS];
}
export const VISIBLE_CHIPS = 6;
