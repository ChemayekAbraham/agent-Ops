import { useSignageDetail } from '@/hooks/useWelileSignages';
import { Button } from '@/components/ui/button';
import { useState } from 'react';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';

/** Mount only inside an opened inspection surface. */
export function SignageEvidence({ signageId, fullPhotoPreview = false }: { signageId: string; fullPhotoPreview?: boolean }) {
  const { data, isPending, error, refetch } = useSignageDetail(signageId);
  const [selectedPhotoIndex, setSelectedPhotoIndex] = useState<number | null>(null);
  if (isPending) return <p role="status" className="text-xs text-muted-foreground">Loading photographs…</p>;
  if (error) return <div role="alert" className="space-y-2 text-xs text-destructive">
    <p>{error.message}</p>
    <Button size="sm" variant="outline" onClick={() => void refetch()}>Retry photographs</Button>
  </div>;
  const photos = [...(data?.photos ?? []), ...(data?.installation_photos ?? [])];
  const selectedPhoto = selectedPhotoIndex === null ? null : photos[selectedPhotoIndex];
  if (!photos.length) return <p className="text-xs text-muted-foreground">No photographs provided.</p>;
  return <><div className="grid grid-cols-2 gap-2">
    {photos.map((photo, index) => <figure key={`${photo.id}-${index}`} className="space-y-1">
      {fullPhotoPreview ? <Button type="button" variant="ghost"
        aria-label={`Open ${photo.caption || photo.category.replace(/_/g, ' ')} photo`}
        onClick={() => setSelectedPhotoIndex(index)}
        className="h-auto aspect-video w-full overflow-hidden rounded-lg border border-border bg-muted p-0 hover:bg-muted">
        <img src={photo.url} alt={photo.caption || photo.category.replace(/_/g, ' ')} className="h-full w-full object-contain" />
      </Button> : <img src={photo.url} alt={photo.caption || photo.category.replace(/_/g, ' ')}
        className="aspect-video w-full rounded-lg border border-border object-cover" />}
      <figcaption className="text-xs text-muted-foreground">{photo.category.replace(/_/g, ' ')}</figcaption>
    </figure>)}
  </div>
    {fullPhotoPreview && <Dialog open={!!selectedPhoto} onOpenChange={(open) => { if (!open) setSelectedPhotoIndex(null); }}>
      <DialogContent stable className="flex h-[100dvh] max-h-[100dvh] w-screen max-w-none flex-col gap-3 rounded-none border-0 bg-background p-4 sm:rounded-none" overlayClassName="bg-background">
        <DialogHeader className="shrink-0 pr-12 text-left">
          <DialogTitle className="tracking-normal">Photographic Evidence</DialogTitle>
          <DialogDescription>{selectedPhoto?.caption || selectedPhoto?.category.replace(/_/g, ' ')}</DialogDescription>
        </DialogHeader>
        {selectedPhoto && <div className="flex min-h-0 flex-1 items-center justify-center overflow-hidden">
          <img src={selectedPhoto.url} alt={selectedPhoto.caption || selectedPhoto.category.replace(/_/g, ' ')} className="h-full w-full object-contain" />
        </div>}
      </DialogContent>
    </Dialog>}
  </>;
}