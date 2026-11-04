import { mkdir, readFile, writeFile, access } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { google } from 'googleapis';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { auth, cleanAlias } from './auth.js';
import { safeError } from './core.js';

const text = (v: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(v, null, 2) }] });
const productSchema = z.object({ name: z.string().min(1).max(300), product_url: z.string().url().optional(), relevance_evidence: z.string().min(15).max(2000), timestamp_seconds: z.number().nonnegative().optional(), replace_product_name: z.string().optional() });
export function validateProducts(products: z.infer<typeof productSchema>[], operation = 'attach') {
  const seen = new Set<string>();
  for (const p of products) {
    if (!p.product_url) { if (operation === 'remove') continue; throw Error('Attaching or replacing needs an exact public product URL.'); }
    const u = new URL(p.product_url);
    if (u.protocol !== 'https:' || u.username || u.password || /^(localhost|127\.|0\.|10\.|192\.168\.|\[|169\.254\.)/i.test(u.hostname)) throw Error('Use a public HTTPS product page without embedded credentials.');
    if (seen.has(u.href)) throw Error('Duplicate product URL.'); seen.add(u.href);
  }
}
const planFile = (id: string) => {
  if (!/^[\w-]{1,80}$/.test(id)) throw Error('Invalid plan ID.');
  return path.resolve('output/shopping', id + '.json');
};
export const studioLimitations = {
  shopping: { api_write_supported: false, route: 'YouTube Studio > Video details > Products > Tag/Edit products > Save', source: 'https://support.google.com/youtube/answer/10191533', note: 'Public Data API video resources have no Shopping attachment field. Description links, keyword tags, Merchant Center product uploads and paid-product-placement disclosure are not Shopping attachments.' },
  related_video: { api_write_supported: false, route: 'YouTube Studio > Short details > Related video > choose the original source > Save', source: 'https://support.google.com/youtube/answer/14075157', note: 'Use the actual Related video field. A source URL in the description is only a description link.' },
};
export function registerStudioTools(server: McpServer) {
  server.tool('get_studio_workflow', 'Return honest Studio-only routes for product tags, Shorts Related video links, and older CTR exports. Does not make changes.', { feature: z.enum(['shopping', 'related_video', 'analytics_export']), video_id: z.string().regex(/^[\w-]{11}$/).optional() }, async a => text(a.feature === 'analytics_export' ? { api_write_supported: false, steps: ['Open the authorized channel in Studio > Analytics > Advanced mode.', 'Set the exact requested dates; choose Content/video rows.', 'Add Impressions, Impressions click-through rate and required audience/revenue columns.', 'Export CSV and call import_studio_csv with its absolute local path.'], note: 'Keep aggregate rows, date boundaries and percentages explicit.' } : { ...studioLimitations[a.feature], video_editor_url: a.video_id ? `https://studio.youtube.com/video/${a.video_id}/edit` : null }));
  server.tool('prepare_shopping_tags', 'Prepare and persist a channel-verified Shopping tag/repair plan for a browser executor. This never attaches products through the Data API.', { channel_alias: z.string(), video_id: z.string().regex(/^[\w-]{11}$/), operation: z.enum(['attach', 'replace', 'remove']).default('attach'), products: z.array(productSchema).min(1).max(60), related_video_id: z.string().regex(/^[\w-]{11}$/).optional() }, async a => {
    try {
      validateProducts(a.products, a.operation); cleanAlias(a.channel_alias);
      if (a.operation === 'replace' && a.products.some(p => !p.replace_product_name)) throw Error('Each replacement needs the existing product name to replace.');
      const api = google.youtube({ version: 'v3', auth: await auth(a.channel_alias) });
      const channel = (await api.channels.list({ part: ['snippet'], mine: true })).data.items?.[0];
      const videos = (await api.videos.list({ part: ['snippet', 'status'], id: [a.video_id, ...(a.related_video_id ? [a.related_video_id] : [])] })).data.items || [];
      if (!channel?.id || !videos.some(v => v.id === a.video_id && v.snippet?.channelId === channel.id)) throw Error('Target video is missing or does not belong to the authorized channel.');
      if (a.related_video_id && !videos.some(v => v.id === a.related_video_id && v.snippet?.channelId === channel.id && ['public', 'unlisted'].includes(v.status?.privacyStatus || ''))) throw Error('Related source must belong to this channel and be public or unlisted.');
      const id = randomUUID();
      const plan = { id, state: 'prepared_requires_studio', created_at: new Date().toISOString(), channel_alias: a.channel_alias, channel_id: channel.id, channel_title: channel.snippet?.title, video_id: a.video_id, video_title: videos.find(v => v.id === a.video_id)?.snippet?.title, operation: a.operation, products: a.products, related_video_id: a.related_video_id || null, ...studioLimitations.shopping, video_editor_url: `https://studio.youtube.com/video/${a.video_id}/edit`, preserve_other_tags: true,
        steps: ['Open the video editor in an existing authenticated browser. Verify channel ID and video ID before editing.', 'Inspect current tags and record unavailable/out-of-stock items. Do not select unrelated products to fill slots.', 'Find the exact eligible catalogue product by its merchant/title/link and verify availability and relevance. A public URL does not prove catalogue eligibility.', 'Perform only the planned attach/remove/replace operations; preserve all unrelated tags. Add timing only where supported and actually featured.', 'If requested for a Short, set the actual Related video field to related_video_id, not only a description link.', 'Save in Studio. Reopen the editor and verify the exact retained/attached products and Related video. Save a screenshot; record_shopping_observation stores attributed evidence only.'],
        limitations: ['This MCP tool does not call private Studio endpoints or automate a separate hidden browser.', 'Catalogue search, eligibility, commissions, tag application and verification need an authenticated Studio browser executor.', 'No commission, availability or successful save is inferred from the plan.'] };
      await mkdir(path.dirname(planFile(id)), { recursive: true }); await writeFile(planFile(id), JSON.stringify(plan, null, 2));
      return text({ ...plan, plan_file: planFile(id) });
    } catch (e) { return { ...text({ error: safeError(e), message: e instanceof Error && !('config' in e) && !('response' in e) ? e.message : undefined }), isError: true }; }
  });
  server.tool('get_shopping_plan', 'Read a prepared Shopping plan and attributed browser observations. A prepared plan is not a live product attachment.', { plan_id: z.string() }, async a => text(JSON.parse(await readFile(planFile(a.plan_id), 'utf8'))));
  server.tool('record_shopping_observation', 'Store an external browser/human observation after reopening Studio. This is an attributed observation, not independent API verification.', { plan_id: z.string(), observer: z.string().min(1), saved_and_reopened: z.boolean(), observed_product_names: z.array(z.string()), observed_related_video_id: z.string().regex(/^[\w-]{11}$/).optional(), screenshot_path: z.string(), notes: z.string().max(4000).default('') }, async a => {
    const p = JSON.parse(await readFile(planFile(a.plan_id), 'utf8'));
    if (!a.saved_and_reopened) throw Error('Reopen Studio after saving before recording a completed observation.');
    if (!path.isAbsolute(a.screenshot_path) || !/\.(png|jpe?g|webp)$/i.test(a.screenshot_path)) throw Error('Provide an absolute screenshot file path.');
    await access(a.screenshot_path);
    const observed = new Set(a.observed_product_names.map(n => n.trim().toLowerCase()));
    if (p.operation !== 'remove' && p.products.some((v: { name: string }) => !observed.has(v.name.trim().toLowerCase()))) throw Error('The observation does not include every planned product.');
    if (p.operation === 'remove' && p.products.some((v: { name: string }) => observed.has(v.name.trim().toLowerCase()))) throw Error('A product planned for removal remains in the observation.');
    if (p.operation === 'replace' && p.products.some((v: { name: string; replace_product_name: string }) => v.name.trim().toLowerCase() !== v.replace_product_name.trim().toLowerCase() && observed.has(v.replace_product_name.trim().toLowerCase()))) throw Error('A replaced product remains in the observation.');
    if (p.related_video_id && a.observed_related_video_id !== p.related_video_id) throw Error('The observed Related video does not match the plan.');
    p.observations ||= []; p.observations.push({ ...a, at: new Date().toISOString(), independently_api_verified: false });
    p.state = 'external_observation_recorded'; await writeFile(planFile(a.plan_id), JSON.stringify(p, null, 2));
    return text({ plan_id: p.id, state: p.state, independently_api_verified: false, note: 'Saved observer evidence; this server cannot verify live Shopping tags through the public Data API.' });
  });
}
