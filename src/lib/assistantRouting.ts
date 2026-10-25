/** Classification is only a routing hint; agent-assistant remains the permission authority. */
export function isPersonalAgentWorkQuery(text: string): boolean {
  const own = /\b(i|my|me|am i)\b/i.test(text);
  return own && /\b(collect(?:ed|ing|ion|ions)?|remaining|tenants?|wallet|balance|advances?)\b/i.test(text)
    && !/\b(how (?:does|do i)|how to|what is welile|products?|services?)\b/i.test(text);
}

export function acceptsPersonalAnswer(data: { outcome?: string; reply?: string } | null | undefined): boolean {
  return !!data?.reply?.trim() && (data.outcome === 'answered' || data.outcome === 'clarify');
}