import { afterEach, describe, expect, it, vi } from 'vitest';

// passportFaceCheck reaches the edge function through the client; nothing here calls it.
vi.mock('@/integrations/supabase/client', () => ({ supabase: {} }));
import { FACE_CHECK_TIMEOUT_MS, TENANT_FACE_PHOTO, facePhotoRefusal, itemsMentioned } from '@/lib/tenantFacePhoto';
import { faceCheckBlocker, runPassportFaceCheckWithin } from '@/lib/passportFaceCheck';

describe('what a return reason points at', () => {
  it('a bare "photo" or "face" is the tenant’s face photo; house, ID and LC1 photos are told apart', () => {
    expect(itemsMentioned(['The photo is blurry'])).toEqual(['tenantPhoto']);
    expect(itemsMentioned(['Face not clear, retake'])).toEqual(['tenantPhoto']);
    expect(itemsMentioned(['Passport photo has a hat'])).toEqual(['tenantPhoto']);
    expect(itemsMentioned(['Photos of the house'])).toEqual(['photos']);
    expect(itemsMentioned(['House photos are dark'])).toEqual(['photos']);
    expect(itemsMentioned(['ID photo (front)'])).toEqual(['idFront']);
    expect(itemsMentioned(['ID photo (back)'])).toEqual(['idBack']);
    expect(itemsMentioned(['LC1 letter (photo)'])).toEqual(['lcLetter']);
  });

  it('names landlord, rent, GPS, family and work; a "rent request" or "work location" is not rent or GPS', () => {
    expect(itemsMentioned(['Wrong landlord phone'])).toEqual(['landlord']);
    expect(itemsMentioned(['Rent amount needed'])).toEqual(['rent']);
    expect(itemsMentioned(['GPS of the house'])).toEqual(['gps']);
    expect(itemsMentioned(['Family size and work are missing'])).toEqual(['familySize', 'work']);
    expect(itemsMentioned(['Please fix this rent request'])).toEqual([]);
    expect(itemsMentioned(['work location missing'])).toEqual(['work']);
    expect(itemsMentioned(['Wrong NIN and a blurry face'])).toEqual(['tenantPhoto', 'idFront']);
    expect(itemsMentioned([null, '', 'Please call the office'])).toEqual([]);
  });
});

describe('a refused face photo, in plain words', () => {
  it('says what is wrong, and leaves other refusals alone', () => {
    expect(facePhotoRefusal("Couldn't upload the tenant's face photo. Check your connection and try again.")).toMatch(/didn’t upload/);
    expect(facePhotoRefusal('enforce_rent_request_tenant_photo: tenant_photo_url is required')).toBe('The tenant’s face photo is missing. Take it now: head and shoulders, face clear.');
    expect(facePhotoRefusal('No face found in the photo')).toMatch(/can’t be seen clearly/);
    expect(facePhotoRefusal('The tenant photo is the same picture as the agent’s own photo')).toMatch(/already used/);
    expect(facePhotoRefusal('NOT_YOUR_REQUEST: this tenant is handled by another agent')).toBeNull();
    expect(facePhotoRefusal('Photos of the house: upload failed')).toBeNull();
  });

  it('one name, and the shared messages use it', () => {
    expect(TENANT_FACE_PHOTO).toBe('Tenant’s face photo (head and shoulders)');
    expect(faceCheckBlocker({ status: 'checking' })).toMatch(/face photo/);
    expect(faceCheckBlocker({ status: 'no_face' })).toMatch(/head and shoulders/);
    expect(faceCheckBlocker({ status: 'skipped_timeout' })).toBeNull();
  });
});

describe('the face check gives up after 15 seconds', () => {
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
  const file = new File(['x'], 'face.jpg', { type: 'image/jpeg' });

  it('no answer in 15 s is skipped_timeout; an answer in time is kept', async () => {
    vi.useFakeTimers();
    const never = vi.fn(() => new Promise<never>(() => {}));
    const pending = runPassportFaceCheckWithin(file, { source: 't' }, FACE_CHECK_TIMEOUT_MS, never);
    await vi.advanceTimersByTimeAsync(FACE_CHECK_TIMEOUT_MS - 1);
    let settled = false;
    void pending.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toMatchObject({ status: 'skipped_timeout' });

    const quick = vi.fn(async () => ({ status: 'ok' as const, sha256: 'abc' }));
    await expect(runPassportFaceCheckWithin(file, { source: 't' }, FACE_CHECK_TIMEOUT_MS, quick)).resolves.toEqual({ status: 'ok', sha256: 'abc' });
  });

  it('offline: skipped at once, without calling the checker', async () => {
    vi.stubGlobal('navigator', { ...navigator, onLine: false });
    const run = vi.fn();
    await expect(runPassportFaceCheckWithin(file, { source: 't' }, FACE_CHECK_TIMEOUT_MS, run)).resolves.toMatchObject({ status: 'skipped_timeout' });
    expect(run).not.toHaveBeenCalled();
  });
});
