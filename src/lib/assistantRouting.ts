import { isAgentCollectionsCoachingQuery } from '../../supabase/functions/_shared/nexaGuides';
/** Classification is only a routing hint; agent-assistant remains the permission authority. */
export function isPersonalAgentWorkQuery(text: string): boolean {
  const own = /\b(i|my|me|am i)\b/i.test(text) || /remaining to collect today/i.test(text);
  return own && /\b(collect(?:ed|ing|ion|ions)?|remaining|tenants?|wallet|balance|advances?)\b/i.test(text)
    && !/\b(how (?:does|do i|can i)|how to|what should i do|what is welile|products?|services?)\b/i.test(text)
    && !isAgentCollectionsCoachingQuery(text);
}

export function acceptsPersonalAnswer(data: { outcome?: string; reply?: string } | null | undefined): boolean {
  // A friendly refusal (out_of_scope) is a final answer too: sending it on to the public bot would
  // let a refused question be answered by something that does not know the person's scope.
  return !!data?.reply?.trim() && (data.outcome === 'answered' || data.outcome === 'clarify' || data.outcome === 'out_of_scope');
}