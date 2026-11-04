import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { google } from 'googleapis';
import type { youtubereporting_v1 } from 'googleapis';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { auth } from './auth.js';
import { assertDate, assertRange, csvEncode, csvObjects, latestReports, monetaryScope, objectRows, presets, safeError, safeSegment, validDownloadUrl, videoFilter, weightedReach } from './core.js';

const alias = z.string();
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const ids = z.array(z.string().regex(/^[\w-]{11}$/)).min(1).max(500).optional();
const text = (data: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] });
const wrap = (fn: (args: any) => Promise<unknown>) => async (args: any) => {
  try { return text(await fn(args)); }
  catch (e) { return { ...text({ error: safeError(e), local_message: e instanceof Error && !('config' in e) && !('response' in e) && !/https?:|bearer|secret/i.test(e.message) ? e.message : undefined }), isError: true }; }
};
export async function queryAnalytics(args: { channel_alias: string; start_date: string; end_date: string; metrics: string; dimensions?: string; filters?: string; sort?: string; max_results?: number; start_index?: number; currency?: string; include_historical_channel_data?: boolean }) {
  assertRange(args.start_date, args.end_date);
  if (/videoThumbnailImpressions|video_thumbnail_impressions/.test(args.metrics)) throw Error('Thumbnail impressions/CTR require reporting_* tools or import_studio_csv, not get_analytics.');
  const client = await auth(args.channel_alias);
  const params = { ids: 'channel==MINE', startDate: args.start_date, endDate: args.end_date, metrics: args.metrics, dimensions: args.dimensions, filters: args.filters, sort: args.sort, maxResults: args.max_results, startIndex: args.start_index, currency: args.currency, includeHistoricalChannelData: args.include_historical_channel_data };
  const data = (await google.youtubeAnalytics({ version: 'v2', auth: client }).reports.query(params)).data;
  return { ...data, records: objectRows(data), requested_start: args.start_date, requested_end: args.end_date, note: 'YouTube may return only dates available for all requested metrics. Missing rows are not zero. Use get_analytics_availability for the latest returned daily date.' };
}
export async function listUploads(args: { channel_alias: string; page_token?: string; max_results?: number; published_after?: string; published_before?: string; compact?: boolean }) {
  if (args.published_after) assertDate(args.published_after);
  if (args.published_before) assertDate(args.published_before);
  const api = google.youtube({ version: 'v3', auth: await auth(args.channel_alias) });
  const channel = (await api.channels.list({ part: ['contentDetails'], mine: true })).data.items?.[0];
  const playlistId = channel?.contentDetails?.relatedPlaylists?.uploads;
  if (!playlistId) throw Error('No uploads playlist for the authorized channel.');
  const page = (await api.playlistItems.list({ part: ['contentDetails'], playlistId, pageToken: args.page_token, maxResults: args.max_results || 50 })).data;
  const videoIds = [...new Set((page.items || []).map(v => v.contentDetails?.videoId).filter((id): id is string => !!id))];
  const items = videoIds.length ? (await api.videos.list({ id: videoIds, part: ['snippet', 'contentDetails', 'statistics', 'status', 'liveStreamingDetails'] })).data.items || [] : [];
  const filtered = items.filter(v => (!args.published_after || (v.snippet?.publishedAt || '') >= args.published_after) && (!args.published_before || (v.snippet?.publishedAt || '').slice(0, 10) <= args.published_before));
  return { channel_id: channel?.id, items: args.compact === false ? filtered : filtered.map(v => ({ id: v.id, title: v.snippet?.title, published_at: v.snippet?.publishedAt, duration: v.contentDetails?.duration, privacy: v.status?.privacyStatus, publish_at: v.status?.publishAt, statistics: v.statistics, live_streaming_details: v.liveStreamingDetails })), next_page_token: page.nextPageToken || null, complete: !page.nextPageToken, scanned_page_items: page.items?.length || 0, note: 'Continue next_page_token even if this filtered page is empty. Deduplicate IDs across pages. Publication dates are UTC; private dates are upload dates, not public release proof.' };
}
export function registerAnalyticsTools(server: McpServer) {
  server.tool('get_video_reach', 'Fetch/cache latest daily reach revisions and compute impression-weighted CTR across a date range. Reports are generated asynchronously; returns missing dates and partial coverage explicitly.', { channel_alias: alias, start_date: date, end_date: date, video_ids: ids, ctr_unit: z.enum(['fraction', 'percent']), report_type: z.enum(['channel_reach_basic_a1', 'channel_reach_combined_a1']).default('channel_reach_basic_a1'), max_reports: z.number().int().min(1).max(100).default(35) }, wrap(async a => {
    assertRange(a.start_date, a.end_date);
    if ((Date.parse(a.end_date) - Date.parse(a.start_date)) / 86400000 > 365) throw Error('Reach queries are limited to 366 calendar dates.');
    const client = await auth(a.channel_alias), api = google.youtubereporting({ version: 'v1', auth: client });
    const jobs: youtubereporting_v1.Schema$Job[] = []; let token: string | undefined;
    for (let page = 0; page < 10; page++) { const r: youtubereporting_v1.Schema$ListJobsResponse = (await api.jobs.list({ pageSize: 100, pageToken: token })).data; jobs.push(...r.jobs || []); token = r.nextPageToken || undefined; if (!token) break; }
    if (token) throw Error('Job pagination limit reached; narrow the account inventory.');
    const matching = jobs.filter(j => j.reportTypeId === a.report_type && (!j.expireTime || Date.parse(j.expireTime) > Date.now()));
    const job = matching[0];
    if (!job?.id) return { status: 'job_not_configured', records: [], next: 'Use reporting_ensure_job for this report type, then allow time for Google to generate reports.' };
    const reportList: youtubereporting_v1.Schema$Report[] = []; token = undefined;
    const endExclusive = new Date(Date.parse(a.end_date) + 86400000).toISOString();
    for (let page = 0; page < 10; page++) { const r: youtubereporting_v1.Schema$ListReportsResponse = (await api.jobs.reports.list({ jobId: job.id, pageSize: 100, pageToken: token, startTimeAtOrAfter: a.start_date + 'T00:00:00Z', startTimeBefore: endExclusive })).data; reportList.push(...r.reports || []); token = r.nextPageToken || undefined; if (!token) break; }
    if (token) throw Error('Report pagination limit reached; use a shorter date range.');
    const directory = path.resolve('output/analytics/bulk', safeSegment(a.channel_alias), safeSegment(job.id)); await mkdir(directory, { recursive: true });
    const metadataFiles = (await readdir(directory)).filter(f => f.endsWith('.csv.metadata.json'));
    if (metadataFiles.length > 5000) throw Error('Archive index exceeds5000files; archive older years separately.');
    const cachedReports: youtubereporting_v1.Schema$Report[] = [];
    for (const file of metadataFiles) {
      const r: youtubereporting_v1.Schema$Report = JSON.parse(await readFile(path.join(directory, file), 'utf8'));
      const day = r.startTime?.slice(0, 10);
      if (r.id && day && day >= a.start_date && day <= a.end_date && (!r.jobId || r.jobId === job.id)) cachedReports.push({ ...r, jobId: job.id });
    }
    const latest = latestReports([...reportList.map(r => ({ ...r, jobId: job.id })), ...cachedReports]), chosen = latest.slice(0, a.max_reports);
    const rows: Record<string, string>[] = [], covered = new Set<string>(); let downloadedBytes = 0;
    for (const r of chosen) {
      if (!r.id) throw Error('Incomplete report metadata returned by Google.');
      const target = path.join(directory, safeSegment(r.id) + '.csv');
      let csv: string;
      try { csv = await readFile(target, 'utf8'); }
      catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; if (!r.downloadUrl) throw Error('An archived report CSV is missing and its remote download has expired.'); csv = (await client.request<string>({ url: validDownloadUrl(r.downloadUrl), responseType: 'text', maxRedirects: 0, timeout: 60000, maxContentLength: 100 * 1024 * 1024 })).data; csvObjects(csv); await writeFile(target, csv); }
      downloadedBytes += Buffer.byteLength(csv); if(downloadedBytes > 100 * 1024 * 1024) throw Error('Reach batch exceeds 100 MiB; query a shorter date range or fewer reports.');
      const records = csvObjects(csv);
      for (const row of records) if (!a.video_ids || a.video_ids.includes(row.video_id)) rows.push(row);
      const day = r.startTime?.slice(0, 10); if (day) covered.add(day);
      const { downloadUrl: _url, ...metadata } = r; await writeFile(target + '.metadata.json', JSON.stringify(metadata, null, 2));
    }
    const expected: string[] = [];
    for (let t = Date.parse(a.start_date); t <= Date.parse(a.end_date); t += 86400000) expected.push(new Date(t).toISOString().slice(0, 10));
    const missing = expected.filter(day => !covered.has(day));
    return { status: !chosen.length ? 'awaiting_generated_reports' : missing.length ? 'partial_coverage' : 'available', job_id: job.id, report_type: a.report_type, ctr_input_unit: a.ctr_unit, records: weightedReach(rows, a.ctr_unit, a.start_date, a.end_date), covered_dates: [...covered].sort(), missing_dates: missing, report_limit_reached: latest.length > chosen.length, reports_used: chosen.map(r => ({ id: r.id, start_time: r.startTime, end_time: r.endTime, created_at: r.createTime })), duplicate_jobs_for_type: matching.length > 1, note: 'Uses exactly one report type/job and newest revisions only. Rates are weighted by impressions. Never substitute30day backfill for a requested90day period. No matching video row is not automatically fabricated as zero.' };
  }));
  server.tool('list_uploads', 'Paginated low-quota uploads inventory, including private/unlisted videos. Continue the next token to cover the channel.', { channel_alias: alias, page_token: z.string().optional(), max_results: z.number().int().min(1).max(50).default(50), published_after: date.optional(), published_before: date.optional(), compact: z.boolean().default(true) }, wrap(listUploads));
  server.tool('get_videos', 'Get video metadata, scheduling/readback, statistics and processing status for up to 50 IDs owned by this channel.', { channel_alias: alias, video_ids: z.array(z.string().regex(/^[\w-]{11}$/)).min(1).max(50) }, wrap(async a => {
    const api = google.youtube({ version: 'v3', auth: await auth(a.channel_alias) });
    const own = (await api.channels.list({ part: ['id'], mine: true })).data.items?.[0]?.id;
    const found = (await api.videos.list({ part: ['snippet', 'status', 'contentDetails', 'statistics', 'processingDetails', 'liveStreamingDetails', 'paidProductPlacementDetails'], id: a.video_ids })).data.items || [];
    return { channel_id: own, items: found.filter(v => v.snippet?.channelId === own), missing_or_not_owned: a.video_ids.filter((id: string) => !found.some(v => v.id === id && v.snippet?.channelId === own)) };
  }));
  server.tool('list_analytics_features', 'List all supported analytics presets, bulk reporting features and Studio-only limitations.', {}, wrap(async () => ({ presets, bulk: ['reach CTR/impressions', 'end screens', 'subtitles', 'traffic', 'devices', 'playlists', 'all report types returned by reporting_list_types'], studio_only: ['unique/returning viewers not exposed by these public reports', 'Shorts viewed versus swiped away', 'Shopping attachment/catalog search', 'Shorts Related video editing'], notes: ['No generic query supports every metric/dimension combination.', 'Revenue requires monetary OAuth consent and eligibility.', 'A newly created reporting job backfills approximately 30 days, not three months; first reports can take up to 48 hours.'] })));
  server.tool('get_analytics_report', 'Run a supported analytics preset for a channel or selected video cohort. Preserves missing values and supports currency.', { channel_alias: alias, report: z.enum(Object.keys(presets) as [string, ...string[]]), start_date: date, end_date: date, video_ids: ids, currency: z.string().regex(/^[A-Z]{3}$/).default('USD'), max_results: z.number().int().min(1).max(200).optional(), start_index: z.number().int().min(1).optional() }, wrap(async a => {
    const p = presets[a.report];
    if (p.singleVideo && a.video_ids?.length !== 1) throw Error('This report requires exactly one video ID.');
    if (a.report === 'monthly' && (!a.start_date.endsWith('-01') || !a.end_date.endsWith('-01'))) throw Error('Use first-of-month dates for monthly reports, or use the daily preset.');
    const filters = [p.filters, videoFilter(a.video_ids)].filter(Boolean).join(';') || undefined;
    const result = await queryAnalytics({ ...a, ...p, filters, max_results: Math.min(a.max_results || p.maxResults || 200, p.maxResults || 200) });
    return { ...result, preset: a.report, currency: p.monetary ? a.currency : undefined, preset_note: p.note, ...(p.monetary ? { derived: result.records.map(r => ({ video: r.video || null, rpm: Number(r.views) > 0 && r.estimatedRevenue != null ? Number(r.estimatedRevenue) / Number(r.views) * 1000 : null })), revenue_note: 'RPM is estimated revenue per1,000 reported views in the selected currency. Not YouTube Shopping commission.' } : {}) };
  }));
  server.tool('get_analytics_availability', 'Probe actual returned daily dates and gaps; no assumption that yesterday is complete.', { channel_alias: alias, start_date: date, end_date: date }, wrap(async a => {
    const r = await queryAnalytics({ ...a, dimensions: 'day', metrics: 'views,estimatedMinutesWatched,averageViewDuration,averageViewPercentage', sort: 'day', max_results: 1000 });
    const dates = r.records.map(x => String(x.day));
    return { requested_start: a.start_date, requested_end: a.end_date, first_returned: dates[0] || null, last_returned: dates.at(-1) || null, returned_dates: dates, note: 'This availability applies to the probed metrics, not monetary or every other metric.' };
  }));
  server.tool('get_video_retention', 'Return standard retention curves separately from optional granular metrics to avoid silently losing curve data.', { channel_alias: alias, video_id: z.string().regex(/^[\w-]{11}$/), start_date: date, end_date: date, include_granular: z.boolean().default(false) }, wrap(async a => {
    const common = { ...a, dimensions: 'elapsedVideoTimeRatio', filters: 'video==' + a.video_id, sort: 'elapsedVideoTimeRatio' };
    const standard = await queryAnalytics({ ...common, metrics: 'audienceWatchRatio,relativeRetentionPerformance' });
    let granular: unknown;
    if (a.include_granular) { try { granular = await queryAnalytics({ ...common, metrics: 'startedWatching,stoppedWatching,totalSegmentImpressions' }); } catch (e) { granular = { error: safeError(e) }; } }
    return { status: standard.records.length ? 'available' : 'no_segment_data', standard, granular, note: 'Empty segment data is unavailable, not zero retention. Watch ratios can exceed1 because segments may be replayed.' };
  }));
  server.tool('export_analytics_report', 'Save a preset report privately under output/analytics with CSV formula protection and request provenance.', { channel_alias: alias, report: z.enum(Object.keys(presets) as [string, ...string[]]), start_date: date, end_date: date, video_ids: ids, currency: z.string().regex(/^[A-Z]{3}$/).default('USD') }, wrap(async a => {
    const p = presets[a.report];
    if (p.singleVideo && a.video_ids?.length !== 1) throw Error('This preset needs exactly one video ID.');
    const r = await queryAnalytics({ ...a, ...p, max_results: p.maxResults || 1000, filters: [p.filters, videoFilter(a.video_ids)].filter(Boolean).join(';') || undefined });
    const out = path.resolve('output/analytics', `${a.channel_alias.replace(/[^\w.-]/g, '_')}-${a.report}-${Date.now()}`);
    await mkdir(out, { recursive: true });
    await writeFile(path.join(out, 'report.csv'), csvEncode(r.records));
    await writeFile(path.join(out, 'report.json'), JSON.stringify(r, null, 2));
    return { directory: out, rows: r.records.length, limited_to: p.maxResults || 1000, note: 'This exports one report page; use start_index with get_analytics_report to paginate ranked reports.' };
  }));
  server.tool('get_channel_capabilities', 'Read-only live probes for channel identity, Analytics, revenue permission and bulk Reporting availability.', { channel_alias: alias, start_date: date, end_date: date }, wrap(async a => {
    const client = await auth(a.channel_alias);
    const channel = (await google.youtube({ version: 'v3', auth: client }).channels.list({ part: ['snippet', 'statistics'], mine: true })).data.items?.[0];
    const result: Record<string, unknown> = { channel: { id: channel?.id, title: channel?.snippet?.title, statistics: channel?.statistics }, saved_scope_includes_revenue: client.credentials.scope?.split(' ').includes(monetaryScope) ?? null };
    for (const [name, metrics] of [['analytics', 'views'], ['revenue', 'estimatedRevenue']]) { try { const r = await queryAnalytics({ ...a, metrics }); result[name] = { status: 'accessible', rows: r.records }; } catch (e) { result[name] = { status: 'blocked', error: safeError(e) }; } }
    try { const r = await google.youtubereporting({ version: 'v1', auth: client }).reportTypes.list({ pageSize: 100 }); result.reporting = { status: 'accessible', available_report_types: r.data.reportTypes?.map(t => ({ id: t.id, name: t.name })), next_page_token: r.data.nextPageToken || null }; }
    catch (e) { result.reporting = { status: 'blocked', error: safeError(e) }; }
    return result;
  }));

  server.tool('reporting_list_types', 'Discover available bulk report types, including reach, end screens, subtitles, playlists and retention.', { channel_alias: alias, page_token: z.string().optional() }, wrap(async a => (await google.youtubereporting({ version: 'v1', auth: await auth(a.channel_alias) }).reportTypes.list({ pageSize: 100, pageToken: a.page_token })).data));
  server.tool('reporting_list_jobs', 'List existing bulk reporting jobs. Does not create jobs.', { channel_alias: alias, page_token: z.string().optional() }, wrap(async a => (await google.youtubereporting({ version: 'v1', auth: await auth(a.channel_alias) }).jobs.list({ pageSize: 100, pageToken: a.page_token })).data));
  server.tool('reporting_ensure_job', 'Reuse a report-type job or prepare/create one. apply=false is a dry run; apply=true creates daily Google reports, never videos.', { channel_alias: alias, report_type_id: z.string().regex(/^[\w-]+$/), name: z.string().min(1).max(100).optional(), apply: z.boolean().default(false) }, wrap(async a => {
    const api = google.youtubereporting({ version: 'v1', auth: await auth(a.channel_alias) });
    const jobs: youtubereporting_v1.Schema$Job[] = []; let token: string | undefined;
    do { const r: youtubereporting_v1.Schema$ListJobsResponse = (await api.jobs.list({ pageSize: 100, pageToken: token })).data; jobs.push(...r.jobs || []); token = r.nextPageToken || undefined; } while (token);
    const existing = jobs.find(j => j.reportTypeId === a.report_type_id && (!j.expireTime || Date.parse(j.expireTime) > Date.now()));
    if (existing) return { created: false, reused: true, job: existing };
    const types: youtubereporting_v1.Schema$ReportType[] = []; token = undefined;
    do { const r: youtubereporting_v1.Schema$ListReportTypesResponse = (await api.reportTypes.list({ pageSize: 100, pageToken: token })).data; types.push(...r.reportTypes || []); token = r.nextPageToken || undefined; } while (token);
    if (!types.some(t => t.id === a.report_type_id && (!t.deprecateTime || Date.parse(t.deprecateTime) > Date.now()))) throw Error('Choose a currently available report type from reporting_list_types.');
    const body = { reportTypeId: a.report_type_id, name: a.name || `YouTube MCP ${a.report_type_id}` };
    if (!a.apply) return { dry_run: true, would_create: body, note: 'First reports can take up to 48 hours, with approximately 30 days historical backfill.' };
    return { created: true, job: (await api.jobs.create({ requestBody: body })).data, note: 'Google generates daily reports. First data can take up to 48 hours. Retrieve/archive reports regularly; old reports expire.' };
  }));
  server.tool('reporting_list_reports', 'List generated daily report metadata without exposing download URLs. Newest revisions replace older overlapping periods.', { channel_alias: alias, job_id: z.string().min(1), page_token: z.string().optional(), created_after: z.string().datetime().optional(), start_time_at_or_after: z.string().datetime().optional(), start_time_before: z.string().datetime().optional() }, wrap(async a => {
    const r = (await google.youtubereporting({ version: 'v1', auth: await auth(a.channel_alias) }).jobs.reports.list({ jobId: a.job_id, pageSize: 100, pageToken: a.page_token, createdAfter: a.created_after, startTimeAtOrAfter: a.start_time_at_or_after, startTimeBefore: a.start_time_before })).data;
    return { reports: latestReports(r.reports || []).map(({ downloadUrl: _url, ...metadata }) => metadata), next_page_token: r.nextPageToken || null, note: 'Continue pagination before selecting latest revisions across the complete result set.' };
  }));
  server.tool('reporting_download_report', 'Download one Google-selected report to private output, validate CSV, and optionally summarize reach. Never accepts arbitrary URLs or returns signed download URLs.', { channel_alias: alias, job_id: z.string().min(1), report_id: z.string().min(1), ctr_unit: z.enum(['fraction', 'percent']).optional() }, wrap(async a => {
    const client = await auth(a.channel_alias), api = google.youtubereporting({ version: 'v1', auth: client });
    const metadata = (await api.jobs.reports.get({ jobId: a.job_id, reportId: a.report_id })).data;
    if (!metadata.downloadUrl) throw Error('This report has no download URL.');
    const response = await client.request<string>({ url: validDownloadUrl(metadata.downloadUrl), responseType: 'text', maxRedirects: 0, timeout: 60000, maxContentLength: 100 * 1024 * 1024 });
    const rows = csvObjects(response.data);
    const out = path.resolve('output/analytics/bulk', safeSegment(a.channel_alias), safeSegment(a.job_id));
    await mkdir(out, { recursive: true });
    const target = path.join(out, safeSegment(a.report_id) + '.csv');
    await writeFile(target, response.data);
    const { downloadUrl: _url, ...safeMetadata } = metadata;
    await writeFile(target + '.metadata.json', JSON.stringify(safeMetadata, null, 2));
    return { file: target, rows: rows.length, metadata: safeMetadata, reach: a.ctr_unit && rows[0]?.video_thumbnail_impressions != null ? weightedReach(rows, a.ctr_unit) : undefined, note: 'CSV stays local. Choose explicit CTR unit before aggregating; do not average rates without impression weights. Do not combine basic and combined reach reports or duplicate revisions.' };
  }));
  server.tool('summarize_reach_csv', 'Summarize an official reach CSV locally, filtering dates and weighting CTR by impressions. Missing CTR remains null.', { file_path: z.string(), ctr_unit: z.enum(['fraction', 'percent']), start_date: date.optional(), end_date: date.optional() }, wrap(async a => {
    if (!path.isAbsolute(a.file_path) || path.extname(a.file_path).toLowerCase() !== '.csv') throw Error('Provide an absolute .csv file path.');
    if (a.start_date) assertDate(a.start_date); if (a.end_date) assertDate(a.end_date);
    if (a.start_date && a.end_date) assertRange(a.start_date, a.end_date);
    return { records: weightedReach(csvObjects(await readFile(a.file_path, 'utf8')), a.ctr_unit, a.start_date, a.end_date), note: 'Only the supplied file is summarized. Combine only non-overlapping latest daily report revisions from one report type.' };
  }));
  server.tool('import_studio_csv', 'Read a local Studio Advanced Mode CSV into records without granting new Google access. Inspect headers before mapping dates or metrics.', { file_path: z.string(), max_rows: z.number().int().min(1).max(2000).default(200) }, wrap(async a => {
    if (!path.isAbsolute(a.file_path) || path.extname(a.file_path).toLowerCase() !== '.csv') throw Error('Provide an absolute .csv file path.');
    const rows = csvObjects(await readFile(a.file_path, 'utf8'));
    return { headers: Object.keys(rows[0] || {}), total_rows: rows.length, records: rows.slice(0, a.max_rows), truncated: rows.length > a.max_rows, note: 'Studio exports can contain aggregate rows and localized headers. No field is silently reinterpreted as API data.' };
  }));
}
