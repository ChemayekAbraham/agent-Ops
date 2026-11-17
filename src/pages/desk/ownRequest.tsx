import { LABEL } from './deskTheme';

/**
 * Staff who are also agents see their own requests on the desks. The server
 * refuses any decision on a request the caller registered or is assigned to
 * ("You cannot decide on a request you registered or are assigned to"), so
 * the desks hide Pass / Send back / Push on those rows and reviews and say why;
 * the row stays visible, read-only.
 *
 * The boards and the review sheet give the request's agent as
 * coalesce(assigned_agent_id, agent_id). A request this person registered but
 * that is now assigned to someone else is not marked; if it is acted on, the
 * server's refusal comes back in the same plain words.
 */

export const OWN_REQUEST_NOTE = 'Your own request — another officer must review it.';

/** True when the signed-in person is one of the request's agents. */
export function isOwnRequest(me: string | null | undefined, ...agentIds: (string | null | undefined)[]): boolean {
  return !!me && agentIds.some((id) => !!id && id === me);
}

const OWN_REFUSAL = /cannot decide on a request you registered or are assigned to/i;

/** The server's refusal for one's own request. */
export const isOwnRequestRefusal = (message: string | null | undefined): boolean => OWN_REFUSAL.test(String(message ?? ''));

/** The refusal in the desks' words; any other message unchanged. */
export const ownRequestWords = (message: string): string => (isOwnRequestRefusal(message) ? OWN_REQUEST_NOTE : message);

/** The grey line on an own row or review. */
export function OwnRequestNote({ className = '' }: { className?: string }) {
  return (
    <p className={`${LABEL} ${className}`} style={{ margin: 0 }} data-own-request>
      {OWN_REQUEST_NOTE}
    </p>
  );
}
