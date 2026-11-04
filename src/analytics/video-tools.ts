import { access, mkdir, writeFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { google } from 'googleapis';
import type { youtube_v3 } from 'googleapis';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { auth } from './auth.js';
import { safeError } from './core.js';

const text = (v: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(v, null, 2) }] });
const wrap = (fn: (a: any) => Promise<unknown>) => async (a: any) => { try { return text(await fn(a)); } catch (e) { return { ...text({ error: safeError(e), message: e instanceof Error && !('config' in e) && !('response' in e) ? e.message : undefined }), isError: true }; } };
const id = z.string().regex(/^[\w-]{11}$/);
const disclosure = { contains_synthetic_media: z.boolean().optional(), synthetic_media_reason: z.string().min(10).max(2000).optional() };
export function validateVideoWrite(a: { publish_at?: string; privacy_status?: string; contains_synthetic_media?: boolean; synthetic_media_reason?: string }, currentPrivacy?: string, now = Date.now()) {
  if (a.publish_at && (!Number.isFinite(Date.parse(a.publish_at)) || Date.parse(a.publish_at) <= now)) throw Error('publish_at must be an ISO8601 date/time in the future.');
  if (a.publish_at && ((a.privacy_status && a.privacy_status !== 'private') || (currentPrivacy && currentPrivacy !== 'private'))) throw Error('Scheduling requires a private video. This tool will not silently privatize an already-public video.');
  if (a.contains_synthetic_media != null && (!a.synthetic_media_reason || a.synthetic_media_reason.trim().length < 10)) throw Error('Provide a per-video synthetic_media_reason for either disclosure value; there is no blanket default.');
}
async function owned(alias: string, videoId: string) {
  const api = google.youtube({ version: 'v3', auth: await auth(alias) });
  const channel = (await api.channels.list({ part: ['id'], mine: true })).data.items?.[0]?.id;
  const video = (await api.videos.list({ part: ['snippet', 'status', 'paidProductPlacementDetails'], id: [videoId] })).data.items?.[0];
  if (!channel || video?.snippet?.channelId !== channel) throw Error('Video is missing or not owned by this channel alias.');
  return { api, video };
}
export function registerVideoTools(server: McpServer) {
  server.tool('upload_video', 'Upload a real video, private by default. Optional future publish_at and explicit per-video synthetic-media review. Does not set Shopping products or Shorts Related video.', {
    channel_alias: z.string(), expected_channel_id: z.string().optional(), file_path: z.string(), title: z.string().min(1).max(100), description: z.string().max(5000).default(''), privacy_status: z.enum(['private', 'unlisted', 'public']).default('private'), publish_at: z.string().datetime({ offset: true }).optional(), tags: z.array(z.string()).max(500).default([]), category_id: z.string().default('22'), made_for_kids: z.boolean().default(false), default_language: z.string().optional(), default_audio_language: z.string().optional(), paid_product_placement: z.boolean().optional(), ...disclosure,
  }, wrap(async a => {
    validateVideoWrite(a);
    if (!path.isAbsolute(a.file_path)) throw Error('file_path must be absolute.'); await access(a.file_path);
    const api = google.youtube({ version: 'v3', auth: await auth(a.channel_alias) });
    const channel = (await api.channels.list({ part: ['id'], mine: true })).data.items?.[0]?.id;
    if (!channel || (a.expected_channel_id && channel !== a.expected_channel_id)) throw Error('Upload channel identity mismatch.');
    const requestBody = { snippet: { title: a.title, description: a.description, tags: a.tags, categoryId: a.category_id, defaultLanguage: a.default_language, defaultAudioLanguage: a.default_audio_language }, status: { privacyStatus: a.privacy_status, publishAt: a.publish_at, selfDeclaredMadeForKids: a.made_for_kids, containsSyntheticMedia: a.contains_synthetic_media }, ...(a.paid_product_placement != null ? { paidProductPlacementDetails: { hasPaidProductPlacement: a.paid_product_placement } } : {}) };
    const result = (await api.videos.insert({ part: ['snippet', 'status', ...(a.paid_product_placement != null ? ['paidProductPlacementDetails'] : [])], requestBody, media: { body: createReadStream(a.file_path) } })).data;
    return { ...result, disclosure_review_reason: a.synthetic_media_reason, note: 'An interrupted/unknown upload outcome must be reconciled before retrying. Shopping products and Related video require Studio.' };
  }));
  server.tool('update_video', 'Update owned video metadata, future scheduling, disclosure or paid placement. Omitted fields remain unchanged; never invents Related video/Shopping fields.', {
    channel_alias: z.string(), video_id: id, title: z.string().min(1).max(100).optional(), description: z.string().max(5000).optional(), tags: z.array(z.string()).max(500).optional(), category_id: z.string().optional(), privacy_status: z.enum(['private', 'unlisted', 'public']).optional(), publish_at: z.string().datetime({ offset: true }).optional(), made_for_kids: z.boolean().optional(), default_language: z.string().optional(), default_audio_language: z.string().optional(), paid_product_placement: z.boolean().optional(), ...disclosure,
  }, wrap(async a => {
    const { api, video } = await owned(a.channel_alias, a.video_id); validateVideoWrite(a, video.status?.privacyStatus || undefined);
    const hasSnippet = ['title', 'description', 'tags', 'category_id', 'default_language', 'default_audio_language'].some(k => a[k] != null);
    const hasStatus = ['privacy_status', 'publish_at', 'made_for_kids', 'contains_synthetic_media'].some(k => a[k] != null);
    const parts = [...(hasSnippet ? ['snippet'] : []), ...(hasStatus ? ['status'] : []), ...(a.paid_product_placement != null ? ['paidProductPlacementDetails'] : [])];
    if (!parts.length) throw Error('Provide at least one metadata field to update.');
    const result = (await api.videos.update({ part: parts, requestBody: { id: a.video_id,
      ...(hasSnippet ? { snippet: { ...video.snippet, title: a.title ?? video.snippet!.title, description: a.description ?? video.snippet!.description, tags: a.tags ?? video.snippet!.tags, categoryId: a.category_id ?? video.snippet!.categoryId, defaultLanguage: a.default_language ?? video.snippet!.defaultLanguage, defaultAudioLanguage: a.default_audio_language ?? video.snippet!.defaultAudioLanguage } } : {}),
      ...(hasStatus ? { status: { ...video.status, privacyStatus: a.privacy_status ?? video.status?.privacyStatus, publishAt: a.publish_at ?? video.status?.publishAt, selfDeclaredMadeForKids: a.made_for_kids ?? video.status?.selfDeclaredMadeForKids, containsSyntheticMedia: a.contains_synthetic_media ?? (video.status as (youtube_v3.Schema$VideoStatus & { containsSyntheticMedia?: boolean | null }) | undefined)?.containsSyntheticMedia } as youtube_v3.Schema$VideoStatus & { containsSyntheticMedia?: boolean | null } } : {}),
      ...(a.paid_product_placement != null ? { paidProductPlacementDetails: { hasPaidProductPlacement: a.paid_product_placement } } : {}),
    } })).data;
    const verified = (await api.videos.list({ part: ['snippet', 'status', 'paidProductPlacementDetails'], id: [a.video_id] })).data.items?.[0];
    return { updated: result, readback: verified, disclosure_review_reason: a.synthetic_media_reason, note: 'Only fields actually returned in readback are verified. Missing disclosure fields are not proof of false.' };
  }));
  server.tool('set_thumbnail', 'Set a custom thumbnail on an owned video from an absolute local image file.', { channel_alias: z.string(), video_id: id, image_path: z.string() }, wrap(async a => { if (!path.isAbsolute(a.image_path)) throw Error('image_path must be absolute.'); await access(a.image_path); const { api } = await owned(a.channel_alias, a.video_id); return (await api.thumbnails.set({ videoId: a.video_id, media: { body: createReadStream(a.image_path) } })).data; }));
  server.tool('list_video_comments', 'Read video comment threads and replies available to the authorized owner. Does not moderate or post.', { channel_alias: z.string(), video_id: id, page_token: z.string().optional(), max_results: z.number().int().min(1).max(100).default(50), order: z.enum(['time', 'relevance']).default('time') }, wrap(async a => { const { api } = await owned(a.channel_alias, a.video_id); return (await api.commentThreads.list({ part: ['snippet', 'replies'], videoId: a.video_id, maxResults: a.max_results, pageToken: a.page_token, order: a.order, textFormat: 'plainText' })).data; }));
  server.tool('list_playlists', 'Read owned playlists with pagination.', { channel_alias: z.string(), page_token: z.string().optional(), max_results: z.number().int().min(1).max(50).default(50) }, wrap(async a => (await google.youtube({ version: 'v3', auth: await auth(a.channel_alias) }).playlists.list({ part: ['snippet', 'contentDetails', 'status'], mine: true, pageToken: a.page_token, maxResults: a.max_results })).data));
  server.tool('list_captions', 'Read caption-track metadata for an owned video. Does not invent a transcript when captions are unavailable.', { channel_alias: z.string(), video_id: id }, wrap(async a => { const { api } = await owned(a.channel_alias, a.video_id); return (await api.captions.list({ part: ['snippet'], videoId: a.video_id })).data; }));
  server.tool('download_caption', 'Download an owned video caption track to local output as SRT or VTT, subject to caption permissions.', { channel_alias: z.string(), video_id: id, caption_id: z.string(), format: z.enum(['srt', 'vtt']).default('srt') }, wrap(async a => {
    const { api } = await owned(a.channel_alias, a.video_id);
    const tracks = (await api.captions.list({ part: ['snippet'], videoId: a.video_id })).data.items || [];
    if (!tracks.some(t => t.id === a.caption_id)) throw Error('Caption track does not belong to the specified video.');
    const content = (await api.captions.download({ id: a.caption_id, tfmt: a.format }, { responseType: 'text' })).data;
    const out = path.resolve('output/analytics/captions', a.video_id + '-' + a.caption_id.replace(/[^\w-]/g, '_') + '.' + a.format); await mkdir(path.dirname(out), { recursive: true }); await writeFile(out, String(content));
    return { file: out, format: a.format };
  }));
}
