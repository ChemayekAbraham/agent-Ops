/**
 * The boardroom screens, shared by the TV page (/board/:token, BoardDisplay)
 * and the Command Centre's Boardroom tab. Each screen takes its data from the
 * caller and has a `switcher` slot for the screen switcher.
 */
export { FundersScreen, type BoardListLoader } from './FundersScreen';
export { PipelineScreen } from './PipelineScreen';
export { OpsMapScreen } from './OpsMapScreen';
export { ScreenSwitcher, AutoRotateButton } from './ScreenSwitcher';
export { useBoardScreenControl } from './useBoardScreenControl';
