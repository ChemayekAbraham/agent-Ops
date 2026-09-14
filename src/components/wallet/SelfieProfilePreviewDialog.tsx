/**
 * Final preview of the cropped verification selfie shown exactly as it will
 * appear as the person's profile picture — round, front and centre. The
 * person confirms or cancels before anything is saved or uploaded; cancelling
 * discards the shot entirely so they can retake it.
 */
import { useEffect, useState } from 'react';
import { Check, RotateCcw, UserRound } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';

export default function SelfieProfilePreviewDialog({
  file,
  open,
  onCancel,
  onConfirm,
}: {
  file: File | null;
  open: boolean;
  onCancel: () => void;
  onConfirm: (file: File) => void;
}) {
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!file) {
      setUrl(null);
      return;
    }
    const objectUrl = URL.createObjectURL(file);
    setUrl(objectUrl);
    return () => URL.revokeObjectURL(objectUrl);
  }, [file]);

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onCancel()}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle className="text-base">Your new profile picture</DialogTitle>
        </DialogHeader>

        <p className="text-xs text-muted-foreground">
          This is exactly how your selfie will appear on your profile and to Financial Ops. Confirm
          to keep it, or cancel to take a new photo.
        </p>

        <div className="mx-auto pt-2">
          {url ? (
            <img
              src={url}
              alt="Profile picture preview"
              className="h-48 w-48 rounded-full border-4 border-primary/40 object-cover shadow-lg"
            />
          ) : (
            <div className="h-48 w-48 rounded-full border-4 border-dashed border-muted bg-muted/40 flex items-center justify-center">
              <UserRound className="h-10 w-10 text-muted-foreground" />
            </div>
          )}
        </div>

        <div className="grid grid-cols-2 gap-2 pt-2">
          <Button variant="outline" className="h-11" onClick={onCancel}>
            <RotateCcw className="h-4 w-4 mr-1.5" />
            Cancel &amp; retake
          </Button>
          <Button className="h-11 font-bold" onClick={() => file && onConfirm(file)}>
            <Check className="h-4 w-4 mr-1.5" />
            Confirm
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
