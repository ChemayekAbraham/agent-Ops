/*
 * Author: SSENKAALI PIUS
 * Email: ssenkaali.pius@welileapp.com
 * Date: 2026-11-16
 * Website: welileapp.com
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@/lib/invokeEdgeFunction', () => ({ invokeEdgeFunction: mocks.invoke }));

import { facePhotoForCheck, facePhotoIsReadyToSend, runPassportFaceCheck } from '@/lib/passportFaceCheck';

const jpeg = (bytes: number, type = 'image/jpeg') =>
  new File([new Uint8Array(bytes)], 'face.jpg', { type });

const graded = { checked: true, is_face: true, is_passport_photo: true, verdict: 'pass', score: 0.9, sha256: 'abc', failures: [] };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.invoke.mockResolvedValue({ data: graded, error: null });
});

describe('what the checker is sent', () => {
  it('passes a small JPEG or PNG through untouched — no decode, no re-encode', async () => {
    for (const type of ['image/jpeg', 'image/jpg', 'image/png']) {
      expect(facePhotoIsReadyToSend(jpeg(120 * 1024, type))).toBe(true);
    }
    const file = jpeg(120 * 1024);
    await expect(facePhotoForCheck(file)).resolves.toBe(file);
  });

  it('re-encodes anything the checker cannot read, or that is too big to send as it is', () => {
    // The capture used to hand this flow a WebP, which the checker does not read.
    expect(facePhotoIsReadyToSend(jpeg(120 * 1024, 'image/webp'))).toBe(false);
    expect(facePhotoIsReadyToSend(jpeg(700 * 1024))).toBe(false);
    expect(facePhotoIsReadyToSend(jpeg(0))).toBe(false);
  });

  it('sends the picture as a picture, with the source and subject in headers', async () => {
    const file = jpeg(80 * 1024);
    const res = await runPassportFaceCheck(file, { source: 'agent_rent_request', subjectUserId: 'tenant-1' });
    expect(res.status).toBe('ok');
    expect(mocks.invoke).toHaveBeenCalledTimes(1);
    const [fn, opts] = mocks.invoke.mock.calls[0];
    expect(fn).toBe('verify-passport-photo');
    expect(opts.body).toBe(file);
    expect(opts.headers).toEqual({
      'Content-Type': 'image/jpeg',
      'x-photo-source': 'agent_rent_request',
      'x-subject-user-id': 'tenant-1',
    });
    // No base64: the bytes never become a string on the phone.
    expect(JSON.stringify(opts)).not.toContain('image_base64');
  });

  it('leaves out the subject when the tenant has no account yet', async () => {
    await runPassportFaceCheck(jpeg(80 * 1024), { source: 'agent_rent_request' });
    expect(mocks.invoke.mock.calls[0][1].headers).not.toHaveProperty('x-subject-user-id');
  });
});

describe('a deployment that predates the binary body', () => {
  it('says it again as base64 rather than telling the agent it could not be checked', async () => {
    mocks.invoke
      .mockResolvedValueOnce({ data: null, error: new Error('Invalid request body') })
      .mockResolvedValueOnce({ data: graded, error: null });
    const res = await runPassportFaceCheck(jpeg(80 * 1024), { source: 'agent_rent_request' });
    expect(res.status).toBe('ok');
    expect(mocks.invoke).toHaveBeenCalledTimes(2);
    expect(mocks.invoke.mock.calls[1][1].body.image_base64).toMatch(/^data:image\/jpeg;base64,/);
    expect(mocks.invoke.mock.calls[1][1].body.source).toBe('agent_rent_request');
  });

  it('does not retry a refusal that is about the photo itself', async () => {
    mocks.invoke.mockResolvedValue({ data: null, error: new Error('That photo is larger than 5 MB') });
    const res = await runPassportFaceCheck(jpeg(80 * 1024), { source: 'agent_rent_request' });
    expect(res.status).toBe('unavailable');
    expect(mocks.invoke).toHaveBeenCalledTimes(1);
  });
});

describe('what blocks', () => {
  it('a definite "no face" blocks; no verdict at all does not', async () => {
    mocks.invoke.mockResolvedValue({ data: { ...graded, is_face: false }, error: null });
    expect((await runPassportFaceCheck(jpeg(1024), { source: 's' })).status).toBe('no_face');

    mocks.invoke.mockResolvedValue({ data: { checked: true }, error: null });
    expect((await runPassportFaceCheck(jpeg(1024), { source: 's' })).status).toBe('unavailable');
  });
});
