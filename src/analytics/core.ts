import type { youtubeAnalytics_v2, youtubereporting_v1 } from 'googleapis';

export const analyticsScope = 'https://www.googleapis.com/auth/yt-analytics.readonly';
export const monetaryScope = 'https://www.googleapis.com/auth/yt-analytics-monetary.readonly';
export const managementScopes = ['https://www.googleapis.com/auth/youtube', 'https://www.googleapis.com/auth/youtube.upload'];
export function authorizationScopes(includeRevenue = false) {
  return [...managementScopes, 'https://www.googleapis.com/auth/youtube.readonly', analyticsScope, ...(includeRevenue ? [monetaryScope] : [])];
}
export function assertDate(date: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0, 10) !== date) throw Error('Expected a real YYYY-MM-DD date.');
  return date;
}
export function assertRange(start: string, end: string) {
  assertDate(start); assertDate(end);
  if (start > end) throw Error('start_date must not follow end_date.');
}
export function videoFilter(ids?: string[]) {
  if (!ids?.length) return undefined;
  if (ids.length > 500 || ids.some(id => !/^[\w-]{11}$/.test(id))) throw Error('Provide at most 500 valid video IDs.');
  return 'video==' + [...new Set(ids)].join(',');
}
export function objectRows(data: youtubeAnalytics_v2.Schema$QueryResponse) {
  return (data.rows || []).map(row => Object.fromEntries((data.columnHeaders || []).map((h, i) => [h.name!, row[i]])));
}
export function safeError(error: unknown) {
  const e = error as { response?: { status?: number; data?: { error?: { message?: string; errors?: { reason?: string }[] } } } };
  const status = e.response?.status ?? null;
  const message = e.response?.data?.error?.message || '';
  const reasons = e.response?.data?.error?.errors?.map(x => x.reason).filter(Boolean) || [];
  const disabled = /has not been used|disabled|accessNotConfigured|SERVICE_DISABLED/i.test(message + reasons.join(','));
  const unsupported = /query is not supported|Unknown identifier|Unknown metric/i.test(message);
  const permission = /permission|unauthori[sz]ed|insufficient/i.test(message);
  return {
    status, reasons,
    code: disabled ? 'api_disabled' : unsupported ? 'unsupported_query' : permission ? 'permission_required' : status === 429 ? 'quota_exceeded' : 'request_failed',
    message: disabled ? 'Enable YouTube Reporting API in the existing Google Cloud project.' : unsupported ? 'This metric/dimension combination is not supported. Use a documented preset or the bulk Reporting API for impressions/CTR.' : permission ? 'The current channel authorization cannot access this report. Monetary reports need revenue consent and channel eligibility.' : 'The request failed; credentials and request internals are omitted.',
  };
}

const engagement = 'views,engagedViews,estimatedMinutesWatched,averageViewDuration,averageViewPercentage,likes,dislikes,comments,shares,subscribersGained,subscribersLost,videosAddedToPlaylists,videosRemovedFromPlaylists';
const discovery = 'views,engagedViews,estimatedMinutesWatched';
export const presets: Record<string, { dimensions?: string; metrics: string; filters?: string; sort?: string; maxResults?: number; singleVideo?: boolean; monetary?: boolean; note?: string }> = {
  overview: { metrics: engagement },
  daily: { dimensions: 'day', metrics: engagement, sort: 'day' },
  monthly: { dimensions: 'month', metrics: engagement, sort: 'month', note: 'Month reports require dates on the first day of a month; use daily for partial months.' },
  videos: { dimensions: 'video', metrics: engagement, sort: '-views', maxResults: 200 },
  content_types: { dimensions: 'creatorContentType', metrics: 'views,engagedViews,estimatedMinutesWatched,averageViewDuration,averageViewPercentage,subscribersGained' },
  traffic: { dimensions: 'insightTrafficSourceType', metrics: discovery },
  search_terms: { dimensions: 'insightTrafficSourceDetail', metrics: discovery, filters: 'insightTrafficSourceType==YT_SEARCH', sort: '-views', maxResults: 25 },
  suggested_videos: { dimensions: 'insightTrafficSourceDetail', metrics: discovery, filters: 'insightTrafficSourceType==RELATED_VIDEO', sort: '-views', maxResults: 25 },
  external_sites: { dimensions: 'insightTrafficSourceDetail', metrics: discovery, filters: 'insightTrafficSourceType==EXT_URL', sort: '-views', maxResults: 25 },
  browse_sources: { dimensions: 'insightTrafficSourceDetail', metrics: discovery, filters: 'insightTrafficSourceType==SUBSCRIBER', sort: '-views', maxResults: 25 },
  countries: { dimensions: 'country', metrics: discovery, sort: '-views', maxResults: 200 },
  devices: { dimensions: 'deviceType', metrics: discovery },
  operating_systems: { dimensions: 'operatingSystem', metrics: discovery },
  playback_locations: { dimensions: 'insightPlaybackLocationType', metrics: discovery },
  subscribed_status: { dimensions: 'subscribedStatus', metrics: 'views,engagedViews,estimatedMinutesWatched,averageViewDuration,averageViewPercentage' },
  demographics: { dimensions: 'ageGroup,gender', metrics: 'viewerPercentage' },
  sharing: { dimensions: 'sharingService', metrics: 'shares' },
  cards: { metrics: 'cardImpressions,cardClicks,cardClickRate,cardTeaserImpressions,cardTeaserClicks,cardTeaserClickRate' },
  live_vs_on_demand: { dimensions: 'liveOrOnDemand', metrics: 'views,engagedViews,estimatedMinutesWatched,averageViewDuration' },
  concurrent_viewers: { dimensions: 'livestreamPosition', metrics: 'averageConcurrentViewers,peakConcurrentViewers', singleVideo: true },
  premium: { metrics: 'redViews,estimatedRedMinutesWatched' },
  revenue: { metrics: 'views,estimatedRevenue,estimatedAdRevenue,estimatedRedPartnerRevenue,monetizedPlaybacks,adImpressions,playbackBasedCpm,cpm', monetary: true },
  revenue_by_video: { dimensions: 'video', metrics: 'views,estimatedRevenue,estimatedAdRevenue,estimatedRedPartnerRevenue,monetizedPlaybacks,adImpressions,playbackBasedCpm,cpm', monetary: true, sort: '-estimatedRevenue', maxResults: 200 },
  ad_types: { dimensions: 'adType', metrics: 'grossRevenue,adImpressions,cpm', monetary: true },
};

// A small RFC4180 parser, including quoted commas, escaped quotes, CRLF and newlines.
export function parseCsv(text: string): string[][] {
  const rows: string[][] = []; let row: string[] = [], value = '', quoted = false;
  text = text.replace(/^\uFEFF/, '');
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') { if (quoted && text[i + 1] === '"') { value += '"'; i++; } else if (quoted || value === '') quoted = !quoted; else throw Error('Malformed CSV quote.'); }
    else if (!quoted && (c === ',' || c === '\n' || c === '\r')) {
      row.push(value); value = '';
      if (c !== ',') { if (c === '\r' && text[i + 1] === '\n') i++; if (row.some(x => x !== '')) rows.push(row); row = []; }
    } else value += c;
  }
  if (quoted) throw Error('Unterminated CSV quote.');
  if (value || row.length) { row.push(value); if (row.some(x => x !== '')) rows.push(row); }
  return rows;
}
export function csvObjects(text: string) {
  const [headers, ...rows] = parseCsv(text);
  if (!headers) return [];
  if (new Set(headers).size !== headers.length) throw Error('Duplicate CSV headers.');
  return rows.map(r => {
    if (r.length !== headers.length) throw Error('CSV row has a different column count from its header.');
    return Object.fromEntries(headers.map((h, i) => [h, r[i]]));
  });
}
export function csvEncode(rows: Record<string, unknown>[]) {
  const headers = [...new Set(rows.flatMap(r => Object.keys(r)))];
  const cell = (v: unknown) => {
    let s = v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
    if (typeof v === 'string' && /^[=+@-]/.test(s)) s = "'" + s;
    return '"' + s.replaceAll('"', '""') + '"';
  };
  return '\uFEFF' + [headers, ...rows.map(r => headers.map(h => r[h]))].map(r => r.map(cell).join(',')).join('\r\n') + '\r\n';
}
export function latestReports(reports: youtubereporting_v1.Schema$Report[]) {
  const best = new Map<string, youtubereporting_v1.Schema$Report>();
  for (const r of reports) {
    const key = `${r.jobId}:${r.startTime}:${r.endTime}`;
    const previous = best.get(key);
    if (!previous || (r.createTime || '') > (previous.createTime || '')) best.set(key, r);
  }
  return [...best.values()].sort((a, b) => (a.startTime || '').localeCompare(b.startTime || ''));
}
export function validDownloadUrl(raw: string) {
  const u = new URL(raw);
  if (u.protocol !== 'https:' || u.hostname !== 'youtubereporting.googleapis.com' || !u.pathname.startsWith('/v1/media/') || u.username || u.password || u.port) throw Error('Only official YouTube Reporting media URLs are accepted.');
  return u.href;
}
export function safeSegment(value: string) {
  const result = value.replace(/[^\w-]/g, '_');
  if (!result || result.length > 200) throw Error('Invalid artifact identifier.');
  return result;
}
export function weightedReach(rows: Record<string, string>[], unit: 'fraction' | 'percent', start?: string, end?: string) {
  const grouped = new Map<string, { video_id: string; impressions: number; weightedCtr: number; ctrImpressions: number; days: Set<string> }>();
  for (const r of rows) {
    const date = r.date?.replace(/^(\d{4})(\d{2})(\d{2})$/, '$1-$2-$3');
    if (date && ((start && date < start) || (end && date > end))) continue;
    const raw = r.video_thumbnail_impressions;
    if (raw == null || raw === '') throw Error('Missing video_thumbnail_impressions column/value.');
    const impressions = Number(raw);
    if (!Number.isFinite(impressions) || impressions < 0) throw Error('Invalid thumbnail impressions.');
    const rawCtr = r.video_thumbnail_impressions_ctr;
    const ctr = rawCtr == null || rawCtr === '' ? null : Number(rawCtr) / (unit === 'percent' ? 100 : 1);
    if (ctr != null && (!Number.isFinite(ctr) || ctr < 0 || ctr > 1)) throw Error('Invalid CTR; select the correct explicit fraction/percent unit.');
    const key = r.video_id || '';
    const a = grouped.get(key) || { video_id: key, impressions: 0, weightedCtr: 0, ctrImpressions: 0, days: new Set<string>() };
    a.impressions += impressions;
    if (ctr != null) { a.weightedCtr += impressions * ctr; a.ctrImpressions += impressions; }
    if (date) a.days.add(date);
    grouped.set(key, a);
  }
  return [...grouped.values()].map(a => ({ video_id: a.video_id, impressions: a.impressions, ctr_percent: a.ctrImpressions ? a.weightedCtr / a.ctrImpressions * 100 : null, impressions_with_ctr: a.ctrImpressions, covered_dates: [...a.days].sort() }));
}
