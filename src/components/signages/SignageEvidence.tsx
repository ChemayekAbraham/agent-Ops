import { useSignageDetail } from '@/hooks/useWelileSignages';
import { Button } from '@/components/ui/button';

/** Mount only inside an opened inspection surface. */
export function SignageEvidence({ signageId }: { signageId: string }) {
  const { data, isPending, error, refetch } = useSignageDetail(signageId);
  if (isPending) return <p role="status" className="text-xs text-muted-foreground">Loading photographs…</p>;
  if (error) return <div role="alert" className="space-y-2 text-xs text-destructive">
    <p>{error.message}</p>
    <Button size="sm" variant="outline" onClick={() => void refetch()}>Retry photographs</Button>
  </div>;
  const photos = [...(data?.photos ?? []), ...(data?.installation_photos ?? [])];
  if (!photos.length) return <p className="text-xs text-muted-foreground">No photographs provided.</p>;
  return <div className="grid grid-cols-2 gap-2">
    {photos.map((photo, index) => <figure key={`${photo.id}-${index}`} className="space-y-1">
      <img src={photo.url} alt={photo.caption || photo.category.replace(/_/g, ' ')}
        className="aspect-video w-full rounded-lg border border-border object-cover" />
      <figcaption className="text-xs text-muted-foreground">{photo.category.replace(/_/g, ' ')}</figcaption>
    </figure>)}
  </div>;
}