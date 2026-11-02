import { describe, expect, it } from 'vitest';
import { locationNoticeState } from './FunderNewLocationNotice';

const coords = { lat: 0.3, lng: 32.5, accuracyM: 20, at: 1 };

describe('locationNoticeState', () => {
  it('asks when the choice has not been made, including browsers that cannot report it', () => {
    expect(locationNoticeState({ permission: 'prompt', coords: null }, false)).toBe('prompt');
    expect(locationNoticeState({ permission: 'unknown', coords: null }, false)).toBe('prompt');
  });

  it('says where to turn location back on when it is blocked', () => {
    expect(locationNoticeState({ permission: 'denied', coords: null }, false)).toBe('blocked');
  });

  it('stays out of the way when location is allowed, unsupported or already working', () => {
    expect(locationNoticeState({ permission: 'granted', coords: null }, false)).toBeNull();
    expect(locationNoticeState({ permission: 'unsupported', coords: null }, false)).toBeNull();
    expect(locationNoticeState({ permission: 'prompt', coords }, false)).toBeNull();
  });

  it('stays away once put away for this visit', () => {
    expect(locationNoticeState({ permission: 'prompt', coords: null }, true)).toBeNull();
    expect(locationNoticeState({ permission: 'denied', coords: null }, true)).toBeNull();
  });
});
