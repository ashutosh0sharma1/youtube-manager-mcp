import "dotenv/config";
import { execFile } from "node:child_process";
import { access as accessFile, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { access, constants, createReadStream } from "node:fs";
import path from "node:path";
import { google } from "googleapis";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { normalizeYouTubeSources, prepareSource } from "./shorts/media.js";
import { batchManifestPath, createManifest, ensureBatchDirs, readManifest, writeManifest } from "./shorts/store.js";
import { closeSelector, openSelector } from "./shorts/selector-server.js";
import { inspectRender, renderFinal, renderLoopTest, renderPreview } from "./shorts/render.js";
import { assertValidSubmission } from "./shorts/validation.js";
import type { SelectorSubmission } from "./shorts/types.js";
import { auth, cleanAlias, tokenPath, startAuthorization } from "./analytics/auth.js";
import { registerAnalyticsTools, queryAnalytics, listUploads } from "./analytics/tools.js";
import { registerStudioTools } from "./analytics/studio.js";
import { registerVideoTools } from "./analytics/video-tools.js";

const root = process.cwd();
const tokensDir = path.join(root, ".youtube-mcp", "tokens");
const text = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] });

async function youtube(alias: string) { return google.youtube({ version: "v3", auth: await auth(alias) }); }

const server = new McpServer({ name: "youtube-manager", version: "0.2.0" });

server.tool("authorize_channel", "Authorize or safely renew a channel; revenue access is opt-in and existing aliases are pinned to channel identity.", { channel_alias: z.string(), include_revenue: z.boolean().default(false), expected_channel_id: z.string().optional() }, async a => text(await startAuthorization(a.channel_alias, a.include_revenue, a.expected_channel_id)));

server.tool("list_channels", "List locally authorised channel aliases.", {}, async () => {
  try { return text({ aliases: (await readdir(tokensDir)).filter(x => x.endsWith(".json")).map(x => x.slice(0, -5)) }); } catch { return text({ aliases: [] }); }
});
server.tool("disconnect_channel", "Delete the local saved login for an alias.", { channel_alias: z.string() }, async ({ channel_alias }) => { await rm(tokenPath(channel_alias), { force: true }); return text({ disconnected: channel_alias }); });
server.tool("get_channel", "Get the authorised channel profile and aggregate statistics.", { channel_alias: z.string() }, async ({ channel_alias }) => { const api = await youtube(channel_alias); return text((await api.channels.list({ part: ["snippet", "statistics", "contentDetails"], mine: true })).data.items?.[0] ?? {}); });
server.tool("list_videos", "List recent videos (legacy array response). Use list_uploads for pagination and complete inventory.", { channel_alias: z.string(), max_results: z.number().int().min(1).max(50).default(25) }, async a => text((await listUploads({ ...a, compact: false })).items));
server.tool("get_analytics", "Run a custom supported Analytics query with sorting, pagination and currency. Use Reporting tools for thumbnail CTR.", { channel_alias: z.string(), start_date: z.string(), end_date: z.string(), metrics: z.string().default("views,estimatedMinutesWatched,averageViewDuration,subscribersGained"), dimensions: z.string().optional(), filters: z.string().optional(), sort: z.string().optional(), max_results: z.number().int().min(1).max(1000).optional(), start_index: z.number().int().min(1).optional(), currency: z.string().regex(/^[A-Z]{3}$/).optional(), include_historical_channel_data: z.boolean().optional() }, async a => text(await queryAnalytics(a)));
registerAnalyticsTools(server);
registerStudioTools(server);
registerVideoTools(server);

server.tool("shorts_create_batch", "Prepare a local YouTube Shorts batch from public YouTube video URLs. This downloads audio and creates cached browser previews; it never uploads or publishes.", {
  channel_alias: z.string().default("sbs"),
  urls: z.array(z.string().url()).min(1).max(10),
  batch_id: z.string().optional(),
}, async ({ channel_alias, urls, batch_id }) => {
  const inputs = normalizeYouTubeSources(urls);
  if (batch_id && await accessFile(batchManifestPath(batch_id)).then(() => true).catch(() => false)) throw new Error(`Batch already exists: ${batch_id}`);
  const manifest = createManifest(channel_alias, batch_id);
  await ensureBatchDirs(manifest.batchId);
  await writeManifest(manifest, "created");
  const sources = [];
  const errors: Array<{ url: string; error: string }> = [];
  for (const input of inputs) {
    try { sources.push(await prepareSource(manifest.batchId, input)); }
    catch (error) { errors.push({ url: input.url, error: error instanceof Error ? error.message : String(error) }); }
  }
  manifest.sources = sources;
  manifest.status = sources.length === inputs.length ? "sources-ready" : "draft";
  await writeManifest(manifest, "sources-ready");
  return text({ batchId: manifest.batchId, status: manifest.status, sources, errors, next: sources.length ? `Call shorts_open_selector with batch_id=${manifest.batchId}.` : "Fix the source errors and retry." });
});

server.tool("shorts_get_batch", "Read the current YouTube Shorts batch manifest, including exact submitted audio selections and render paths.", { batch_id: z.string() }, async ({ batch_id }) => text(await readManifest(batch_id)));

server.tool("shorts_open_selector", "Open the temporary localhost waveform selector for a prepared Shorts batch.", { batch_id: z.string() }, async ({ batch_id }) => {
  const manifest = await readManifest(batch_id);
  if (!manifest.sources.length) throw new Error("The batch has no prepared sources.");
  const selector = await openSelector(batch_id);
  execFile("cmd.exe", ["/c", "start", "", `\"${selector.url}\"`], () => undefined);
  return text({ ...selector, next: "Choose and loop sections in the browser, then click Submit selections to Codex. Call shorts_get_batch afterward." });
});

server.tool("shorts_close_selector", "Close the temporary selector server for a Shorts batch.", { batch_id: z.string() }, async ({ batch_id }) => { closeSelector(batch_id); return text({ batchId: batch_id, closed: true }); });

server.tool("shorts_validate_selection", "Validate the current submitted Shorts selections without rendering or uploading.", { batch_id: z.string() }, async ({ batch_id }) => {
  const manifest = await readManifest(batch_id);
  const submissions: SelectorSubmission[] = manifest.shorts.map((item) => ({ sourceId: item.sourceId, ...item.audioEdit, relatedVideoId: item.relatedVideoId, template: item.template }));
  assertValidSubmission(manifest, submissions);
  return text({ batchId: batch_id, status: manifest.status, valid: true, selections: manifest.shorts.map((item) => ({ id: item.id, sourceId: item.sourceId, startMs: item.audioEdit.startMs, endMs: item.audioEdit.endMs, loopCount: item.audioEdit.loopCount, relatedVideoId: item.relatedVideoId })) });
});

server.tool("shorts_render_loop_test", "Render an exact FFmpeg loop test from a submitted audio selection. This does not create a video or upload anything.", { batch_id: z.string(), short_id: z.string() }, async ({ batch_id, short_id }) => text(await renderLoopTest(batch_id, short_id)));

server.tool("shorts_render_preview", "Render a half-scale, watermarked vertical Remotion preview from an audio-approved selection.", { batch_id: z.string(), short_id: z.string() }, async ({ batch_id, short_id }) => text(await renderPreview(batch_id, short_id)));

server.tool("shorts_approve_final", "Mark a previewed Short as approved for a full-resolution render. This does not upload or publish.", { batch_id: z.string(), short_id: z.string() }, async ({ batch_id, short_id }) => {
  const manifest = await readManifest(batch_id);
  const item = manifest.shorts.find((short) => short.id === short_id);
  if (!item || item.status !== "preview-rendered") throw new Error("Render and review a preview before approving the final.");
  item.status = "final-approved";
  await writeManifest(manifest, `final-approved-${short_id}-${Date.now()}`);
  return text({ batchId: batch_id, shortId: short_id, status: item.status });
});

server.tool("shorts_render_final", "Render a full-resolution 1080x1920 Remotion MP4 from a final-approved selection. This does not upload or publish.", { batch_id: z.string(), short_id: z.string() }, async ({ batch_id, short_id }) => text(await renderFinal(batch_id, short_id)));

server.tool("shorts_inspect_render", "Inspect a rendered Shorts MP4 with ffprobe.", { file_path: z.string() }, async ({ file_path }) => text(await inspectRender(file_path)));

server.tool("shorts_prepare_upload", "Prepare private-upload metadata and the related-video handoff for a rendered Short. It performs no YouTube write.", { batch_id: z.string(), short_id: z.string(), title: z.string().max(100).optional(), description: z.string().max(5000).optional(), hashtags: z.array(z.string()).max(30).default([]) }, async ({ batch_id, short_id, title, description, hashtags }) => {
  const manifest = await readManifest(batch_id);
  const item = manifest.shorts.find((short) => short.id === short_id);
  if (!item) throw new Error(`Short not found: ${short_id}`);
  const source = manifest.sources.find((candidate) => candidate.sourceId === item.sourceId);
  if (!source) throw new Error(`Source not found for Short: ${short_id}`);
  if (!item.finalPath) throw new Error("Render the final MP4 before preparing upload metadata.");
  const finalTitle = title || item.title || source.title;
  const finalDescription = description || `${source.title}\n\nOriginal video: https://www.youtube.com/watch?v=${item.relatedVideoId}`;
  return text({ batchId: batch_id, shortId: short_id, filePath: item.finalPath, channelAlias: manifest.channelAlias, title: finalTitle, description: finalDescription, tags: hashtags, privacyStatus: "private", relatedVideoId: item.relatedVideoId, relatedVideoUrl: `https://www.youtube.com/watch?v=${item.relatedVideoId}`, next: "Call upload_video with privacy_status=private only after explicit approval. Then add the related video in YouTube Studio." });
});

await server.connect(new StdioServerTransport());
