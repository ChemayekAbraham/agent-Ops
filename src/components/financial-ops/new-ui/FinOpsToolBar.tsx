import { Link, useSearchParams } from 'react-router-dom';
import { ChevronLeft } from 'lucide-react';
import { FINOPS_MENU_GROUPS } from './finopsMenu';

/**
 * A slim gradient strip above whichever tool is open in the new look: a way back to the menu and the tool's name.
 * The tool underneath is the Command Center exactly as it is today.
 */
export default function FinOpsToolBar() {
  const [params] = useSearchParams();
  const id = params.get('tool') ?? params.get('view');
  const label = FINOPS_MENU_GROUPS.flatMap((g) => g.entries).find((e) => e.id === id)?.label;

  return (
    <div
      className="mb-3 flex items-center gap-3 rounded-2xl px-3 py-2.5 text-white shadow-sm sm:mb-4 sm:px-4"
      style={{ background: 'linear-gradient(135deg, #4C158D 0%, #9234EA 100%)' }}
    >
      <Link
        to="/admin/financial-ops?hub=1&ui=new"
        className="inline-flex h-9 shrink-0 items-center gap-1 rounded-xl bg-white/20 px-2.5 text-sm font-semibold hover:bg-white/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60"
      >
        <ChevronLeft className="h-4 w-4" aria-hidden />
        Menu
      </Link>
      <div className="min-w-0">
        <p className="text-[10px] font-bold uppercase tracking-[0.12em] text-white/70">Financial Ops</p>
        <p className="truncate text-sm font-bold leading-tight sm:text-base">{label ?? 'Tool'}</p>
      </div>
    </div>
  );
}
