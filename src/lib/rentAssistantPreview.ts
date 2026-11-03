/**
 * Who sees the Rent Request Assistant preview on the agent dashboard.
 * The assistant posts real rent requests, so it stays limited to these
 * accounts until it replaces the form.
 */
export const RENT_ASSISTANT_PREVIEW_EMAILS = ['pexpert46@gmail.com'];

export function canSeeRentAssistantPreview(email: string | null | undefined): boolean {
  return !!email && RENT_ASSISTANT_PREVIEW_EMAILS.includes(email.trim().toLowerCase());
}
