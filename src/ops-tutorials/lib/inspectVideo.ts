const SLICE = 1024 * 1024;

export async function inspectVideo(file: File): Promise<{ durationSeconds: number; videoCodec: string }> {
  const { createFile, MP4BoxBuffer } = await import('mp4box');
  const mp4 = createFile();
  let info: any = null;
  let parseError: unknown = null;
  mp4.onReady = (i: any) => { info = i; };
  mp4.onError = (_module: string, message: string) => { parseError = message; };

  let offset = 0;
  while (!info && !parseError && offset < file.size) {
    const ab = await file.slice(offset, offset + SLICE).arrayBuffer();
    const buf = MP4BoxBuffer.fromArrayBuffer(ab, offset);
    const next = mp4.appendBuffer(buf);
    offset = typeof next === 'number' && next > offset ? next : offset + ab.byteLength;
  }
  if (!info) mp4.flush();
  if (!info) throw new Error('Could not read this video file');

  const track = (info.videoTracks ?? [])[0];
  const codec: string = track?.codec ?? 'unknown';
  if (!codec.startsWith('avc1')) {
    throw new Error(`This video is not H.264 (found ${codec}). Re-export it as MP4 / H.264 so it plays on every phone.`);
  }
  const durationSeconds = Math.round((info.duration / info.timescale) * 10) / 10;
  return { durationSeconds, videoCodec: codec };
}
