import test from 'node:test';
import assert from 'node:assert/strict';
import { authorizationScopes, monetaryScope, assertDate, assertRange, videoFilter, csvObjects, csvEncode, latestReports, validDownloadUrl, weightedReach, safeError, presets, safeSegment } from '../dist/analytics/core.js';
import { assertChannelIdentity, mergeCredentials, cleanAlias, renderAuthorizationPage } from '../dist/analytics/auth.js';
import { validateVideoWrite } from '../dist/analytics/video-tools.js';
import { validateProducts, studioLimitations } from '../dist/analytics/studio.js';

test('monetary consent is opt-in while existing management and readonly scopes remain', () => {
  assert.ok(!authorizationScopes().includes(monetaryScope));
  assert.ok(authorizationScopes(true).includes(monetaryScope));
  assert.ok(authorizationScopes(true).includes('https://www.googleapis.com/auth/youtube.readonly'));
});
test('alias/channel guards reject traversal and wrong-account renewal', () => {
  assert.equal(cleanAlias('xidit.@n'), 'xidit.@n');
  assert.throws(() => cleanAlias('../sbs'));
  assert.throws(() => assertChannelIdentity('UCwrong', 'UCsbs'));
  assert.throws(() => assertChannelIdentity(undefined, 'UCsbs'));
  assert.doesNotThrow(() => assertChannelIdentity('UCsbs', 'UCsbs'));
});
test('a verified renewal retains the refresh token when Google omits a replacement', () => {
  const merged = mergeCredentials({ refresh_token: 'fixture-refresh', scope: 'fixture-scope' }, { access_token: 'fixture-access' });
  assert.equal(merged.refresh_token, 'fixture-refresh');
  assert.equal(merged.scope, 'fixture-scope');
  assert.throws(() => mergeCredentials({}, {}));
});
test('calendar validation rejects rollover dates and inverted ranges', () => {
  assert.equal(assertDate('2024-02-29'), '2024-02-29');
  assert.throws(() => assertDate('2026-02-29'));
  assert.throws(() => assertDate('2026-13-01'));
  assert.throws(() => assertRange('2026-10-21', '2026-07-21'));
});
test('video filters deduplicate IDs and cannot inject query expressions', () => {
  assert.equal(videoFilter(['12345678901','12345678901']), 'video==12345678901');
  assert.throws(() => videoFilter(['12345678901;country==IN']));
});
test('CSV ingestion handles BOM, quoted commas, quotes and embedded newlines', () => {
  const rows = csvObjects('\uFEFFid,title,n\r\nv1,"A, ""quote""\nline",4\r\n');
  assert.deepEqual(rows, [{ id:'v1',title:'A, "quote"\nline',n:'4' }]);
  assert.throws(() => csvObjects('a,b\n"bad,1'));
  assert.throws(() => csvObjects('a,b\n1,2,3'));
  assert.throws(() => csvObjects('a,a\n1,2'));
});
test('CSV export protects spreadsheet formulas without turning numeric values into strings', () => {
  const encoded = csvEncode([{ title:'=WEBSERVICE("fixture")', views:12, missing:null }]);
  const [row] = csvObjects(encoded);
  assert.ok(row.title.startsWith("'="));
  assert.equal(row.views,'12'); assert.equal(row.missing,'');
});
test('CTR aggregation is weighted by impressions, not a mean of daily percentages', () => {
  const rows = [{ date:'20261001',video_id:'v',video_thumbnail_impressions:'100',video_thumbnail_impressions_ctr:'0.1' }, {date:'20261002',video_id:'v',video_thumbnail_impressions:'900',video_thumbnail_impressions_ctr:'0.02'}];
  const [r] = weightedReach(rows,'fraction');
  assert.equal(r.impressions,1000); assert.ok(Math.abs(r.ctr_percent-2.8)<1e-10);
  assert.equal(weightedReach(rows,'fraction','2026-10-02','2026-10-02')[0].impressions,900);
});
test('missing CTR remains missing and scale validation prevents 100-fold mistakes', () => {
  const r = {video_id:'v',video_thumbnail_impressions:'100',video_thumbnail_impressions_ctr:''};
  assert.equal(weightedReach([r],'fraction')[0].ctr_percent,null);
  assert.throws(()=>weightedReach([{...r,video_thumbnail_impressions_ctr:'4.5'}],'fraction'));
  assert.equal(weightedReach([{...r,video_thumbnail_impressions_ctr:'4.5'}],'percent')[0].ctr_percent,4.5);
  assert.throws(()=>weightedReach([{...r,video_thumbnail_impressions:'bad'}],'fraction'));
});
test('backfill selection replaces old revisions and retains different jobs/periods', () => {
  const reports=[{id:'old',jobId:'j',startTime:'a',endTime:'b',createTime:'2026-10-01'}, {id:'new',jobId:'j',startTime:'a',endTime:'b',createTime:'2026-10-02'}, {id:'other',jobId:'k',startTime:'a',endTime:'b',createTime:'2026-10-01'}];
  assert.deepEqual(latestReports(reports).map(r=>r.id).sort(),['new','other']);
});
test('report download cannot send OAuth credentials to arbitrary hosts or redirects', () => {
  assert.equal(validDownloadUrl('https://youtubereporting.googleapis.com/v1/media/fixture?alt=media'),'https://youtubereporting.googleapis.com/v1/media/fixture?alt=media');
  for(const url of ['https://evil.test/v1/media/a','http://youtubereporting.googleapis.com/v1/media/a','https://youtubereporting.googleapis.com.evil.test/v1/media/a','https://user:pass@youtubereporting.googleapis.com/v1/media/a','https://youtubereporting.googleapis.com/not-media'])assert.throws(()=>validDownloadUrl(url));
});
test('errors classify disabled APIs, bad queries and consent without leaking SDK internals', () => {
  const e={response:{status:403,data:{error:{message:'API disabled fixture private material',errors:[{reason:'accessNotConfigured'}]}}},config:{headers:{Authorization:'fixture'}}};
  const cleaned=safeError(e);assert.equal(cleaned.code,'api_disabled');assert.ok(!JSON.stringify(cleaned).includes('private material'));assert.ok(!JSON.stringify(cleaned).includes('Authorization'));
  assert.equal(safeError({response:{status:400,data:{error:{message:'The query is not supported'}}}}).code,'unsupported_query');
  assert.equal(safeError({response:{status:401,data:{error:{message:'Insufficient permission'}}}}).code,'permission_required');
});
test('scheduling rejects past dates and accidental publication while preserving private schedules', () => {
  const now=Date.parse('2026-10-21T00:00:00Z');
  assert.throws(()=>validateVideoWrite({publish_at:'2026-10-20T00:00:00Z'},'private',now));
  assert.throws(()=>validateVideoWrite({publish_at:'2026-10-22T00:00:00Z'},'public',now));
  assert.throws(()=>validateVideoWrite({publish_at:'2026-10-22T00:00:00Z',privacy_status:'public'},'private',now));
  assert.doesNotThrow(()=>validateVideoWrite({publish_at:'2026-10-22T00:00:00Z',privacy_status:'private'},'private',now));
});
test('both synthetic-media values require an individual review reason', () => {
  for(const v of [true,false])assert.throws(()=>validateVideoWrite({contains_synthetic_media:v}));
  assert.doesNotThrow(()=>validateVideoWrite({contains_synthetic_media:false,synthetic_media_reason:'Original owned audio with licensed historical still images.'}));
  assert.doesNotThrow(()=>validateVideoWrite({}));
});
test('Shopping plans reject private/duplicate links and report Studio-only capability honestly', () => {
  const p={name:'fixture',product_url:'https://shop.example/product',relevance_evidence:'The product is shown in the recording.'};
  assert.doesNotThrow(()=>validateProducts([p]));
  assert.throws(()=>validateProducts([p,p]));
  assert.throws(()=>validateProducts([{...p,product_url:'https://127.0.0.1/product'}]));
  assert.equal(studioLimitations.shopping.api_write_supported,false);
  assert.equal(studioLimitations.related_video.api_write_supported,false);
});
test('presets keep incompatible live/APV metrics apart and enforce detail report limits', () => {
  assert.ok(!presets.live_vs_on_demand.metrics.includes('averageViewPercentage'));
  for(const k of ['search_terms','suggested_videos','external_sites','browse_sources'])assert.equal(presets[k].maxResults,25);
  assert.ok(presets.revenue.monetary);assert.ok(presets.concurrent_viewers.singleVideo);
});

test('artifact IDs cannot traverse output directories',()=>{assert.equal(safeSegment('..'),'__');assert.equal(safeSegment('../x'),'___x');assert.throws(()=>safeSegment(''));});

test('unavailable product removal does not require inventing a URL',()=>{const p={name:'Unavailable item',relevance_evidence:'Previously tagged product is no longer available.'};assert.doesNotThrow(()=>validateProducts([p],'remove'));assert.throws(()=>validateProducts([p],'attach'));});
test('browser-neutral authorization page escapes labels and link attributes',()=>{const page=renderAuthorizationPage('<script>fixture</script>','https://accounts.google.com/fixture?a=1&b="fixture"',true);assert.ok(!page.includes('<script>'));assert.ok(page.includes('&lt;script&gt;'));assert.ok(page.includes('&amp;b=&quot;fixture&quot;'));assert.ok(page.includes('read-only access to revenue analytics'));});
