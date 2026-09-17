/**
 * Tells someone, once, that the holder of a National ID removed them from it.
 * The notice stays until they acknowledge it.
 */
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { useAcknowledgeUnlinkNotice, useNationalIdUnlinkNotices, maskNationalId } from '@/hooks/useNationalIdGroup';

export default function NationalIdUnlinkNoticeDialog() {
  const { data } = useNationalIdUnlinkNotices();
  const ack = useAcknowledgeUnlinkNotice();
  const notice = data?.[0];
  if (!notice) return null;

  return (
    <AlertDialog open>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>You were removed from a National ID</AlertDialogTitle>
          <AlertDialogDescription className="space-y-2">
            <span className="block">
              {notice.owner_name || 'The ID holder'} removed your account from National ID{' '}
              {maskNationalId(notice.nin_masked)}. You are no longer attached to it.
            </span>
            <span className="block rounded-xl bg-muted/60 p-3 text-foreground">
              Reason given: {notice.reason}
            </span>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogAction disabled={ack.isPending} onClick={() => ack.mutate(notice.id)}>
            I understand
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
