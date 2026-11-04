import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import path from "node:path";
import type { BatchManifest, SelectorSubmission } from "./types.js";
import { applySubmission, batchPath, readManifest, writeManifest } from "./store.js";
import { assertValidSubmission } from "./validation.js";
import { renderSelectorHtml } from "./selector-template.js";

interface RunningSelector { server: Server; port: number }
const running = new Map<string, RunningSelector>();

function json(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "content-length": Buffer.byteLength(text) });
  res.end(text);
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 1_000_000) throw new Error("Request is too large.");
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function selectorData(manifest: BatchManifest): Promise<unknown> {
  return {
    batchId: manifest.batchId,
    channelAlias: manifest.channelAlias,
    sources: await Promise.all(manifest.sources.map(async (source) => {
      let waveform: { sampleRate: number; peaks: number[] } = { sampleRate: 50, peaks: [] };
      try { waveform = JSON.parse(await readFile(source.waveformPath, "utf8")) as typeof waveform; } catch { /* graph is optional */ }
      return {
        sourceId: source.sourceId,
        videoId: source.videoId,
        youtubeUrl: source.youtubeUrl,
        title: source.title,
        channelTitle: source.channelTitle,
        durationMs: source.durationMs,
        thumbnailUrl: source.thumbnailUrl,
        previewUrl: `/media/${encodeURIComponent(source.sourceId)}/preview`,
        waveform,
      };
    })),
  };
}

function contentType(filePath: string): string {
  if (filePath.endsWith(".json")) return "application/json; charset=utf-8";
  if (filePath.endsWith(".m4a")) return "audio/mp4";
  return "application/octet-stream";
}

export async function openSelector(batchId: string): Promise<{ url: string; port: number; batchId: string }> {
  const existing = running.get(batchId);
  if (existing) return { url: `http://127.0.0.1:${existing.port}/`, port: existing.port, batchId };
  const server = createServer(async (req, res) => {
    try {
      const requestUrl = new URL(req.url ?? "/", "http://127.0.0.1");
      const manifest = await readManifest(batchId);
      if (req.method === "GET" && requestUrl.pathname === "/") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
        res.end(renderSelectorHtml(manifest, await selectorData(manifest)));
        return;
      }
      if (req.method === "GET" && requestUrl.pathname === "/api/state") { json(res, 200, manifest); return; }
      if (req.method === "GET" && requestUrl.pathname.startsWith("/media/")) {
        const [, , encodedSourceId, kind] = requestUrl.pathname.split("/");
        const sourceId = decodeURIComponent(encodedSourceId ?? "");
        const source = manifest.sources.find((candidate) => candidate.sourceId === sourceId);
        if (!source || !["preview", "waveform"].includes(kind ?? "")) { json(res, 404, { error: "Media not found." }); return; }
        const filePath = kind === "preview" ? source.previewPath : source.waveformPath;
        const resolved = path.resolve(filePath);
        const root = path.resolve(batchPath(batchId));
        if (!resolved.startsWith(`${root}${path.sep}`)) { json(res, 403, { error: "Media path rejected." }); return; }
        const fileStat = await stat(filePath);
        const range = req.headers.range;
        if (kind === "preview" && range) {
          const match = /^bytes=(\d*)-(\d*)$/.exec(range);
          if (match) {
            const start = match[1] ? Number(match[1]) : 0;
            const requestedEnd = match[2] ? Number(match[2]) : fileStat.size - 1;
            const end = Math.min(fileStat.size - 1, requestedEnd);
            if (start >= 0 && start <= end) {
              res.writeHead(206, { "content-type": contentType(filePath), "cache-control": "no-store", "accept-ranges": "bytes", "content-range": `bytes ${start}-${end}/${fileStat.size}`, "content-length": end - start + 1 });
              createReadStream(filePath, { start, end }).pipe(res);
              return;
            }
          }
        }
        res.writeHead(200, { "content-type": contentType(filePath), "cache-control": "no-store", "accept-ranges": kind === "preview" ? "bytes" : "none", "content-length": fileStat.size });
        createReadStream(filePath).pipe(res);
        return;
      }
      if (req.method === "POST" && requestUrl.pathname === "/api/submit") {
        const body = await readJson(req) as { submissions?: SelectorSubmission[] };
        const submissions = Array.isArray(body.submissions) ? body.submissions : [];
        assertValidSubmission(manifest, submissions);
        manifest.shorts = applySubmission(manifest, submissions);
        manifest.status = "audio-approved";
        const revisionPath = await writeManifest(manifest, `selection-${Date.now()}`);
        json(res, 200, { ok: true, batchId, revisionPath, shorts: manifest.shorts });
        return;
      }
      json(res, 404, { error: "Not found." });
    } catch (error) {
      json(res, 400, { error: error instanceof Error ? error.message : String(error) });
    }
  });
  const port = await new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") return reject(new Error("Could not determine selector port."));
      resolve(address.port);
    });
  });
  running.set(batchId, { server, port });
  return { url: `http://127.0.0.1:${port}/`, port, batchId };
}

export function closeSelector(batchId: string): void {
  const selector = running.get(batchId);
  if (!selector) return;
  selector.server.close();
  running.delete(batchId);
}
