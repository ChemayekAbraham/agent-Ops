import { useNavigate } from 'react-router-dom';
import { Clapperboard } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useTutorialAccess } from '../useTutorialAccess';

export default function TutorialVideosButton() {
  const navigate = useNavigate();
  const { hasAccess } = useTutorialAccess();
  if (!hasAccess) return null;
  return (
    <div className="flex justify-end">
      <Button variant="outline" size="sm" className="gap-1.5" onClick={() => navigate('/me/tutorials')}>
        <Clapperboard className="h-4 w-4" />
        Tutorial videos
      </Button>
    </div>
  );
}
