// supabase/functions/_shared/groundingClaims.ts
/** Status words that need a backing record before Zoe or Nexa may say them. */
export const UNBACKED_STATUS_RE = /\b(escalat(?:ed|ing)|forwarded to (?:our|the) team|(?:has|have) been (?:submitted|recorded|received|approved|processed)|i(?:'|\u2019)ve (?:recorded|noted|submitted|passed)|(?:is|are) (?:being )?process(?:ed|ing)|under review|will get back to you)\b/i;
