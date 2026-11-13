import { useCallback, useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  BOARD_POLL_MS,
  boardIsStale,
  readBoardFeed,
  readBoardList,
  readBoardPeriod,
  storeBoardPeriod,
  type BoardFeed,
  type BoardList,
  type BoardMetric,
  type BoardPeriod,
  type BoardScreen,
} from '@/lib/boardDisplay';
import { FundersScreen, OpsMapScreen, PipelineScreen, useBoardScreenControl, type BoardListLoader } from '@/pages/board';
import { supabase } from '@/integrations/supabase/client';
import { rpc } from './reviewApi';
import { ErrorLine } from './ui';

/**
 * The Command Centre's Boardroom view (E97): the boardroom TV's three screens,
 * Funders · Pipeline · Ops map, with the TV's switcher and Auto-rotate, for
 * signed-in COO / CEO / Command Centre / Funders Dashboard staff. The data is
 * `boardroom_feed(p_screen)`, the TV feed's shape with names included; the
 * screens, switcher and rotate control are CFO 1's (src/pages/board), used
 * unchanged. Refetched every 30 s like the TV. The screens fill the window, so
 * a "Command Centre" button sits in their switcher slot to come back.
 * A server refusal is shown in its own words.
 */

export function useBoardroomFeed(screen: BoardScreen) {
  return useQuery({
    queryKey: ['desk-feed', 'boardroom', screen],
    queryFn: async (): Promise<BoardFeed> => {
      const { data, error } = await rpc('boardroom_feed', { p_screen: screen });
      if (error) throw error;
      return readBoardFeed(data);
    },
    refetchInterval: BOARD_POLL_MS,
    staleTime: 15_000,
    retry: 1,
  });
}

/** Not in the generated types yet; the builder is kept so the list can be cancelled. */
type ListRpc = (
  fn: 'boardroom_list',
  args: { p_period: BoardPeriod; p_kind: BoardMetric },
) => { abortSignal: (s: AbortSignal) => PromiseLike<{ data: unknown; error: { message: string; code?: string } | null }> };

/**
 * The requests behind a funders tile (E97b): `boardroom_list`, the signed-in
 * twin of the TV's board_display_list (count, ugx, shown, rows with names),
 * read with the TV's own readBoardList. A refusal keeps the server's words.
 */
export const loadBoardroomList: BoardListLoader = async (period, kind, signal): Promise<BoardList> => {
  const { data, error } = await (supabase.rpc as unknown as ListRpc)('boardroom_list', { p_period: period, p_kind: kind }).abortSignal(signal);
  if (error) throw Object.assign(new Error(error.message), { code: error.code });
  return readBoardList(data, period, kind);
};

const asIs = (e: unknown) => String((e as { message?: string } | null)?.message ?? e ?? 'Something went wrong.');
const storage = () => {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
};

export function Boardroom({ onClose }: { onClose: () => void }) {
  // The last feed that came; kept while the next screen's answer is on its way, as the TV does.
  const [feed, setFeed] = useState<BoardFeed | null>(null);
  const control = useBoardScreenControl(feed, { syncHash: false });
  const q = useBoardroomFeed(control.wanted ?? 'funders');
  const [now, setNow] = useState(() => Date.now());
  const [period, setPeriodState] = useState<BoardPeriod>(() => readBoardPeriod(storage()));
  const setPeriod = useCallback((p: BoardPeriod) => {
    setPeriodState(p);
    storeBoardPeriod(storage(), p);
  }, []);

  useEffect(() => {
    if (q.data) setFeed(q.data);
  }, [q.data]);
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(t);
  }, []);

  const back = (
    <button type="button" className="screen-tab" data-boardroom-back onClick={onClose}>
      ← Command Centre
    </button>
  );
  const switcher = (
    <>
      {back}
      {control.switcher}
    </>
  );
  const stale = boardIsStale(q.dataUpdatedAt || null, now);
  const errorText = q.error ? asIs(q.error) : null;

  // Refused before anything came: the server's words, and the way back.
  if (!feed && q.error) {
    return (
      <section aria-label="Boardroom" data-boardroom="refused" className="space-y-3">
        <ErrorLine>{asIs(q.error)}</ErrorLine>
        <button type="button" onClick={onClose} className="text-sm underline underline-offset-4">
          Back to the Command Centre
        </button>
      </section>
    );
  }

  const shown = feed?.display.screen ?? 'funders';
  return (
    <section aria-label="Boardroom" data-boardroom={shown} data-rotate={control.rotate || undefined}>
      {feed && shown === 'map' && feed.map ? (
        <OpsMapScreen switcher={switcher} label={feed.display.label} map={feed.map} now={now} stale={stale} errorText={errorText} idle={false} />
      ) : feed && shown === 'pipeline' ? (
        <PipelineScreen switcher={switcher} label={feed.display.label} stages={feed.stages ?? []} now={now} stale={stale} errorText={errorText} idle={false} />
      ) : (
        <FundersScreen
          feed={feed}
          period={period}
          onPeriodChange={setPeriod}
          loadList={loadBoardroomList}
          now={now}
          stale={stale}
          error={errorText ? { text: errorText, fatal: false } : null}
          idle={false}
          switcher={switcher}
        />
      )}
    </section>
  );
}
