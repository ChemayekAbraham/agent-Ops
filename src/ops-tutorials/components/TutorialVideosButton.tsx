import { useNavigate } from 'react-router-dom';
import { Clapperboard } from 'lucide-react';
import { Button } from '@/components/ui/button';

export default function TutorialVideosButton() {
  const navigate = useNavigate();
  return (
    <div className="flex justify-end">
      <Button variant="outline" size="sm" className="gap-1.5" onClick={() => navigate('/me/tutorials')}>
        <Clapperboard className="h-4 w-4" />
        Tutorial videos
      </Button>
    </div>
  );
}
