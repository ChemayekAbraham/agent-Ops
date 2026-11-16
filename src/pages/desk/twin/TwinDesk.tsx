import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '@/integrations/supabase/client';
import { staffSource } from './twinSource';
import { TwinView } from './TwinView';

/**
 * The Twin tab of the Ops Command Centre (/desk/twin), drawn inside the desk
 * frame. Reads with the signed-in session: the database checks who may see it
 * (OPS_TWIN_NOT_ALLOWED otherwise) and withholds partner detail from anyone
 * but the COO, CEO, CFO, CTO and super admins.
 */
export default function TwinDesk({ board }: { board: boolean }) {
  const source = useMemo(() => staffSource(supabase), []);
  const navigate = useNavigate();
  return (
    <div className={board ? 'h-full overflow-auto pb-8' : ''}>
      <TwinView source={source} board={board} onOpenDesk={(desk) => navigate(`/desk/${desk}${board ? '?board=1' : ''}`)} />
    </div>
  );
}
