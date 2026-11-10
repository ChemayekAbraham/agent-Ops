import { FEATURE_FUNDERS_UI_V3, useFeaturePreviewState, type FeaturePreviewState } from '@/hooks/useFeaturePreview';

/** Preview switch name for the funder V3 dashboard (see useFeaturePreview). */
export const FUNDERS_UI_V3_FEATURE = FEATURE_FUNDERS_UI_V3;

export type FunderUiV3PreviewState = FeaturePreviewState;

/** Whether this viewer has the `funders_ui_v3` preview switch. Default OFF. */
export function useFunderUiV3PreviewState(
  userId: string | null | undefined,
  options: { network?: boolean } = {},
): FunderUiV3PreviewState {
  return useFeaturePreviewState(FEATURE_FUNDERS_UI_V3, userId, options);
}

/** Shorthand: just the on/off answer. */
export function useFunderUiV3Preview(userId: string | null | undefined): boolean {
  return useFunderUiV3PreviewState(userId).on;
}
