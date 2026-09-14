import { useEffect, useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';

interface Props {
  file: File | null;
  /** Discard the shot entirely — the person retakes it. */
  onCancel: () => void;
  onConfirm: () => void;
}

/** Final look-at-it step before the cropped selfie becomes the profile picture. */
export default function SelfieProfilePreviewDialog({ file, onCancel, onConfirm }: Props) {
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!file) { setUrl(null); return; }
    const objectUrl = URL.createObjectURL(file);
    setUrl(objectUrl);
    return () => URL.revokeObjectURL(objectUrl);
  }, [file]);

  return (
    <Dialog open={!!file} onOpenChange={(o) => { if (!o) onCancel(); }}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Your new profile picture</DialogTitle>
          <DialogDescription>
            This is how your picture will look. Your original photo stays in your verification
            history for Financial Ops.
          </DialogDescription>
        </DialogHeader>

        <div className="flex justify-center py-2">
          {url && (
            <img
              src={url}
              alt="Preview of your new profile picture"
              className="h-48 w-48 rounded-full border-4 border-primary/40 object-cover"
            />
          )}
        </div>

        <div className="grid grid-cols-2 gap-2">
          <Button variant="outline" onClick={onCancel}>Cancel &amp; retake</Button>
          <Button onClick={onConfirm}>Confirm</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
