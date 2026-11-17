/**
 * Dev-only Playwright harness for the boardroom's PIPELINE and OPS MAP
 * screens with the live E96 data shapes (src/lib/boardMap.fixtures), for the
 * 1920×1080 screenshots of the light theme (and ?theme=dark).
 *
 * Mounted at `/__e2e/board-screens` only when `import.meta.env.DEV` is true.
 *   screen=pipeline|map   (default pipeline)
 *   theme=dark            the dark look (light is the default)
 */
import { useSearchParams } from 'react-router-dom';
import { MAP, STAGES_RAW } from '@/lib/boardMap.fixtures';
import { readBoardMap, readStages } from '@/lib/boardMap';
import { OpsMapScreen } from '@/pages/board/OpsMapScreen';
import { PipelineScreen } from '@/pages/board/PipelineScreen';

const NOW = Date.parse('2026-11-16T09:00:00Z');

export default function BoardScreensHarness() {
  const [params] = useSearchParams();
  const map = readBoardMap(MAP, STAGES_RAW);
  if (params.get('screen') === 'map' && map) {
    return <OpsMapScreen label="Kampala office" map={map} now={NOW} stale={false} errorText={null} idle={false} />;
  }
  return <PipelineScreen label="Kampala office" stages={readStages(STAGES_RAW)} now={NOW} stale={false} errorText={null} idle={false} />;
}
