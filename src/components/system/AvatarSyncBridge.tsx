import { useAvatarQuerySync } from '@/hooks/useAvatarQuerySync';

/**
 * Renders nothing. Keeps every cached view that shows a face in sync the
 * instant a profile picture changes anywhere in the app (or in another tab).
 */
const AvatarSyncBridge = () => {
  useAvatarQuerySync();
  return null;
};

export default AvatarSyncBridge;
