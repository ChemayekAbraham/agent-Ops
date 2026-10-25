import { describe,it,expect } from 'vitest';
import { hasFunderTenant,hasFunderLandlord,hasFunderGps,getFunderHouseCompleteness,getFunderHouseCompletenessRank,sortFunderHousesByCompleteness,sortFunderFeedEntries } from '@/lib/funderHouseSort';
const complete={id:'test-complete',tenant_first_name:'TEST_TENANT',landlord_name:'TEST_LANDLORD',request_latitude:0.3,request_longitude:32.5};
describe('funder house completeness',()=>{
  it('rejects tenant placeholders and accepts a recorded tenant name',()=>{
    expect(hasFunderTenant({tenant_name:'No tenant'})).toBe(false);
    expect(hasFunderTenant({tenant_first_name:'  pending '})).toBe(false);
    expect(hasFunderTenant(complete)).toBe(true);
  });
  it('rejects landlord placeholders and accepts a recorded landlord name',()=>{
    expect(hasFunderLandlord({landlord_name:'Unknown'})).toBe(false);
    expect(hasFunderLandlord({landlordName:'TEST_LANDLORD'})).toBe(true);
  });
  it('requires finite valid GPS pair, not null, missing, boolean or 0,0',()=>{
    expect(hasFunderGps({latitude:null,longitude:32})).toBe(false);
    expect(hasFunderGps({latitude:0,longitude:0})).toBe(false);
    expect(hasFunderGps({latitude:91,longitude:32})).toBe(false);
    expect(hasFunderGps({latitude:true,longitude:32})).toBe(false);
    expect(hasFunderGps({latitude:0,longitude:'32'})).toBe(true);
    expect(hasFunderGps({latitude:1,request_longitude:32})).toBe(false);
  });
  it('ranks all three fields first and none last',()=>{
    expect(getFunderHouseCompleteness(complete)).toEqual({hasTenant:true,hasLandlord:true,hasGps:true,complete:true,isComplete:true,isFullyVerified:true,completenessScore:3,rank:0,badgeLabel:'Verified: Tenant + Landlord + GPS'});
    expect(getFunderHouseCompletenessRank(complete)).toBe(0);
    expect(getFunderHouseCompletenessRank({})).toBe(3);
    expect(getFunderHouseCompletenessRank({tenant_name:'TEST_TENANT'})).toBe(2);
    expect(getFunderHouseCompletenessRank({landlord_name:'TEST_LANDLORD'})).toBe(2);
    expect(getFunderHouseCompletenessRank({tenant_name:'TEST_TENANT',landlord_name:'TEST_LANDLORD'})).toBe(1);
  });
  it('sorts complete houses first without mutating or disturbing tied input',()=>{
    const input=[{id:'test-empty'},{id:'test-other'},complete];
    expect(sortFunderHousesByCompleteness(input).map(r=>r.id)).toEqual(['test-complete','test-empty','test-other']);
    expect(input[0].id).toBe('test-empty');
  });
  it('accepts only Uganda coordinate bounds or explicit GPS flags',()=>{
    expect(hasFunderGps({location_lat:-2.5,location_lng:28.5})).toBe(true);
    expect(hasFunderGps({latitude:5.5,longitude:36})).toBe(true);
    expect(hasFunderGps({latitude:5.51,longitude:32})).toBe(false);
    expect(hasFunderGps({latitude:1,longitude:28.49})).toBe(false);
    expect(hasFunderGps({has_gps:true})).toBe(true);
    expect(hasFunderGps({gps_verified:true})).toBe(true);
    expect(hasFunderGps({has_gps:'true'})).toBe(false);
  });
  it('places complete tenant plans above empty houses across the combined feed',()=>{
    const entries=[{category:'empty',item:{id:'test-empty'}},{category:'ready',item:complete}];
    expect(sortFunderFeedEntries(entries).map(e=>e.category)).toEqual(['ready','empty']);
  });
});