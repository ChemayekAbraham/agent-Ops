import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { subscribeAvatarUpdates } from '@/lib/avatarSync';

/**
 * Whenever anyone's profile picture changes, refresh every cached query that
 * could be showing a face — profiles, verification queues, audit/decision
 * logs, leaderboards, chat, reviews, public profiles. Mounted once, inside the
 * QueryClientProvider.
 */
const AVATAR_BEARING_KEY_HINTS = [
  'profile',
  'avatar',
  'user',
  'holder',
  'payout-verification',
  'payout-decision',
  'identity',
  'leaderboard',
  'league',
  'ranking',
  'chat',
  'message',
  'review',
  'staff',
  'agent',
  'tenant',
  'landlord',
  'supporter',
  'seller',
  'member',
];

function keyMentionsAvatarSurface(key: unknown): boolean {
  const flat = JSON.stringify(key ?? '').toLowerCase();
  return AVATAR_BEARING_KEY_HINTS.some((hint) => flat.includes(hint));
}

export function useAvatarQuerySync(): void {
  const queryClient = useQueryClient();

  useEffect(() => {
    return subscribeAvatarUpdates(() => {
      queryClient.invalidateQueries({
        predicate: (query) => keyMentionsAvatarSurface(query.queryKey),
      });
    });
  }, [queryClient]);
}
