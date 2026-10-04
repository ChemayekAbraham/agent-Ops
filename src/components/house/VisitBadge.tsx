import { Eye, MapPin } from 'lucide-react';

interface VisitBadgeProps {
  reviewCount: number;
}

export default function VisitBadge({ reviewCount }: VisitBadgeProps) {
  if (reviewCount === 0) return null;

  return (
    <div className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-primary/10 text-primary text-xs font-medium">
      <Eye className="h-3 w-3" />
      <span>{reviewCount} verified visit{reviewCount !== 1 ? 's' : ''}</span>
      <MapPin className="h-2.5 w-2.5 opacity-60" />
    </div>
  );
}
