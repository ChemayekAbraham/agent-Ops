/**
 * Deterministic partner reference generator.
 *
 * Produces a stable code of the form WLP-YYYY-XXXXXX where:
 *  - YYYY = the year derived from `createdAt` (or current year as fallback)
 *  - XXXXXX = first 6 alphanumeric characters of the user UUID, uppercased.
 *
 * Because it is derived purely from inputs we already persist (user id +
 * created_at), the same partner gets the same reference across the welcome
 * email, the funder dashboard, and the Partner Ops / COO approval queue —
 * no schema column required.
 */
export function buildPartnerReference(userId: string, createdAt?: string | Date | null): string {
  const year = (() => {
    if (!createdAt) return new Date().getFullYear();
    const d = createdAt instanceof Date ? createdAt : new Date(createdAt);
    return Number.isNaN(d.getTime()) ? new Date().getFullYear() : d.getFullYear();
  })();
  const slug = (userId || '').replace(/[^a-zA-Z0-9]/g, '').slice(0, 6).toUpperCase().padEnd(6, 'X');
  return `WLP-${year}-${slug}`;
}