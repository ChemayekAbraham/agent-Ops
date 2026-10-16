import { inspectVideo } from './inspectVideo';
import { hashFile } from './hashFile';
import { resumableUpload } from './resumableUpload';
import { markUploaded, registerUpload } from '../api';

export type UploadStage = 'checking' | 'hashing' | 'registering' | 'uploading' | 'finalising' | 'done';

export interface UploadTutorialArgs {
  file: File;
  topicId: string;
  kind: 'original' | 'revision';
  supersedesVideoId?: string | null;
  revisionReason?: string | null;
  title: string;
  recordedOn?: string | null;
  onStage?: (stage: UploadStage) => void;
  onProgress?: (p: number) => void;
}

const MAX_BYTES = 500 * 1024 * 1024;

export async function uploadTutorial(args: UploadTutorialArgs): Promise<{ videoId: string; videoCode: string }> {
  const { file, onStage, onProgress } = args;
  onStage?.('checking'); onProgress?.(0);
  const isMp4 = file.type === 'video/mp4' || file.name.toLowerCase().endsWith('.mp4');
  if (!isMp4) throw new Error('Only MP4 videos can be uploaded');
  if (file.size > MAX_BYTES) throw new Error('Max 500 MB — export at 720p');

  const { durationSeconds, videoCodec } = await inspectVideo(file);

  onStage?.('hashing');
  const sha256 = await hashFile(file, onProgress);

  onStage?.('registering'); onProgress?.(0);
  const reg = await registerUpload({
    p_topic_id: args.topicId,
    p_kind: args.kind,
    p_supersedes_video_id: args.supersedesVideoId ?? null,
    p_revision_reason: args.revisionReason ?? null,
    p_title: args.title,
    p_sha256: sha256,
    p_size_bytes: file.size,
    p_duration_seconds: durationSeconds,
    p_video_codec: videoCodec,
    p_recorded_on: args.recordedOn ?? null,
  });

  onStage?.('uploading');
  await resumableUpload(file, reg.storage_path, onProgress);

  onStage?.('finalising');
  await markUploaded(reg.video_id);

  onStage?.('done'); onProgress?.(1);
  return { videoId: reg.video_id, videoCode: reg.video_code };
}
