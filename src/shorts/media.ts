import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { access, copyFile, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { batchPath } from "./store.js";
import type { SourceAsset } from "./types.js";

const execFileAsync = promisify(execFile);

export interface YouTubeSourceInput {
  url: string;
  videoId: string;
}

export function parseYouTubeVideoId(input: string): string {
  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    throw new Error(`Invalid YouTube URL: ${input}`);
  }
  const hostname = parsed.hostname.toLowerCase().replace(/^www\./, "");
  let id = "";
  if (hostname === "youtu.be") id = parsed.pathname.split("/").filter(Boolean)[0] ?? "";
  if (["youtube.com", "m.youtube.com", "music.youtube.com"].includes(hostname)) {
    id = parsed.searchParams.get("v") ?? "";
    if (!id && parsed.pathname.startsWith("/shorts/")) id = parsed.pathname.split("/")[2] ?? "";
    if (!id && parsed.pathname.startsWith("/embed/")) id = parsed.pathname.split("/")[2] ?? "";
  }
  if (!/^[A-Za-z0-9_-]{6,20}$/.test(id)) throw new Error(`URL is not a supported single YouTube video: ${input}`);
  return id;
}

export function normalizeYouTubeSources(urls: string[]): YouTubeSourceInput[] {
  const seen = new Set<string>();
  return urls.map((url) => {
    const videoId = parseYouTubeVideoId(url);
    if (seen.has(videoId)) throw new Error(`Duplicate YouTube video: ${videoId}`);
    seen.add(videoId);
    return { url, videoId };
  });
}

async function run(binary: string, args: string[], cwd?: string): Promise<{ stdout: string; stderr: string }> {
  try {
    return await execFileAsync(binary, args, { cwd, windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
  } catch (error) {
    const detail = error as { message?: string; stderr?: string };
    throw new Error(`${binary} failed: ${detail.stderr || detail.message || String(error)}`);
  }
}

async function runBuffer(binary: string, args: string[], cwd?: string): Promise<Buffer> {
  return await new Promise<Buffer>((resolve, reject) => {
    const child = spawn(binary, args, { cwd, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    const errors: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => errors.push(chunk));
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve(Buffer.concat(chunks));
      else reject(new Error(`ffmpeg failed: ${Buffer.concat(errors).toString("utf8").slice(-4000)}`));
    });
  });
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

async function sha256(filePath: string): Promise<string> {
  const data = await readFile(filePath);
  return createHash("sha256").update(data).digest("hex");
}

async function probeDurationMs(filePath: string): Promise<number> {
  const result = await run("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "json", filePath]);
  const parsed = JSON.parse(result.stdout) as { format?: { duration?: string } };
  const duration = Number(parsed.format?.duration);
  if (!Number.isFinite(duration) || duration <= 0) throw new Error(`Could not determine audio duration for ${filePath}`);
  return Math.round(duration * 1000);
}

async function makePreview(audioPath: string, previewPath: string): Promise<void> {
  await run("ffmpeg", ["-y", "-i", audioPath, "-vn", "-c:a", "aac", "-b:a", "128k", "-ar", "44100", previewPath]);
}

async function makeWaveform(audioPath: string, waveformPath: string): Promise<void> {
  // 50 samples per second is detailed enough for dragging while keeping hour-long sources small.
  const raw = await runBuffer("ffmpeg", ["-v", "error", "-i", audioPath, "-ac", "1", "-ar", "50", "-f", "s16le", "pipe:1"]);
  const peaks: number[] = [];
  let maximum = 1;
  for (let offset = 0; offset + 1 < raw.length; offset += 2) {
    const value = Math.abs(raw.readInt16LE(offset)) / 32768;
    peaks.push(value);
    if (value > maximum) maximum = value;
  }
  const normalized = peaks.map((value) => Number((value / maximum).toFixed(4)));
  const maxPeaks = 12_000;
  const displayPeaks = normalized.length <= maxPeaks ? normalized : Array.from({ length: maxPeaks }, (_, index) => {
    const start = Math.floor(index * normalized.length / maxPeaks);
    const end = Math.max(start + 1, Math.floor((index + 1) * normalized.length / maxPeaks));
    return Number(Math.max(...normalized.slice(start, end)).toFixed(4));
  });
  const { writeFile } = await import("node:fs/promises");
  await writeFile(waveformPath, JSON.stringify({ sampleRate: displayPeaks.length / Math.max(1, normalized.length / 50), peaks: displayPeaks }), "utf8");
}

export async function prepareSource(batchId: string, input: YouTubeSourceInput): Promise<SourceAsset> {
  const sourceDir = batchPath(batchId, "sources");
  const proxyDir = batchPath(batchId, "proxies");
  const waveformDir = batchPath(batchId, "waveform");
  const audioPath = path.join(sourceDir, `${input.videoId}.m4a`);
  const infoPath = path.join(sourceDir, `${input.videoId}.info.json`);
  const previewPath = path.join(proxyDir, `${input.videoId}.m4a`);
  const waveformPath = path.join(waveformDir, `${input.videoId}.json`);

  await access(audioPath).catch(async () => {
    await run("yt-dlp", [
      "--no-playlist",
      "--no-warnings",
      "--write-info-json",
      "--extract-audio",
      "--audio-format",
      "m4a",
      "--audio-quality",
      "0",
      "--output",
      path.join(sourceDir, "%(id)s.%(ext)s"),
      input.url,
    ]);
  });

  // A prior interrupted run may have left the audio but not the metadata.
  if (!(await access(infoPath).then(() => true).catch(() => false))) {
    await run("yt-dlp", ["--no-playlist", "--no-warnings", "--write-info-json", "--skip-download", "--output", path.join(sourceDir, "%(id)s.%(ext)s"), input.url]);
  }
  const info = JSON.parse(await readFile(infoPath, "utf8")) as Record<string, unknown>;
  const durationMs = Math.max(1, Math.round(numberOr(info.duration, await probeDurationMs(audioPath) / 1000) * 1000));
  if (!(await access(previewPath).then(() => true).catch(() => false))) await makePreview(audioPath, previewPath);
  if (!(await access(waveformPath).then(() => true).catch(() => false))) await makeWaveform(audioPath, waveformPath);
  const file = await stat(audioPath);
  if (!file.isFile() || file.size === 0) throw new Error(`Downloaded audio is empty: ${audioPath}`);
  return {
    sourceId: input.videoId,
    videoId: input.videoId,
    youtubeUrl: input.url,
    title: String(info.title ?? input.videoId),
    channelTitle: typeof info.channel === "string" ? info.channel : undefined,
    durationMs,
    thumbnailUrl: typeof info.thumbnail === "string" ? info.thumbnail : undefined,
    audioPath,
    infoPath,
    previewPath,
    waveformPath,
    sha256: await sha256(audioPath),
    preparedAt: new Date().toISOString(),
  };
}

export async function probeMedia(filePath: string): Promise<{ durationMs: number; width?: number; height?: number; fps?: number }> {
  const result = await run("ffprobe", ["-v", "error", "-show_entries", "format=duration:stream=width,height,r_frame_rate", "-of", "json", filePath]);
  const parsed = JSON.parse(result.stdout) as { format?: { duration?: string }; streams?: Array<{ width?: number; height?: number; r_frame_rate?: string }> };
  const stream = parsed.streams?.find((item) => item.width || item.height);
  const [numerator, denominator] = String(stream?.r_frame_rate ?? "0/1").split("/").map(Number);
  return {
    durationMs: Math.round(Number(parsed.format?.duration ?? 0) * 1000),
    width: stream?.width,
    height: stream?.height,
    fps: denominator ? Number((numerator / denominator).toFixed(3)) : undefined,
  };
}

export async function extractSegment(audioPath: string, startMs: number, endMs: number, outputPath: string): Promise<void> {
  const duration = (endMs - startMs) / 1000;
  await run("ffmpeg", ["-y", "-i", audioPath, "-ss", (startMs / 1000).toFixed(3), "-t", duration.toFixed(3), "-vn", "-c:a", "aac", "-b:a", "192k", outputPath]);
}

export async function concatenateAudio(segmentPath: string, loopCount: number, crossfadeMs: number, outputPath: string): Promise<void> {
  if (loopCount <= 1) {
    await run("ffmpeg", ["-y", "-i", segmentPath, "-c:a", "aac", "-b:a", "192k", outputPath]);
    return;
  }
  if (crossfadeMs <= 0) {
    const listPath = `${outputPath}.concat.txt`;
    const { writeFile, rm } = await import("node:fs/promises");
    const escaped = segmentPath.replace(/'/g, "'\\''");
    await writeFile(listPath, Array.from({ length: loopCount }, () => `file '${escaped}'`).join("\n"), "utf8");
    try {
      await run("ffmpeg", ["-y", "-f", "concat", "-safe", "0", "-i", listPath, "-c:a", "aac", "-b:a", "192k", outputPath]);
    } finally {
      await rm(listPath, { force: true });
    }
    return;
  }
  const args = ["-y"];
  for (let index = 0; index < loopCount; index += 1) args.push("-i", segmentPath);
  const filterParts: string[] = [];
  let current = "0:a";
  const fadeSeconds = (crossfadeMs / 1000).toFixed(3);
  for (let index = 1; index < loopCount; index += 1) {
    const output = `xf${index}`;
    filterParts.push(`[${current}][${index}:a]acrossfade=d=${fadeSeconds}:c1=tri:c2=tri[${output}]`);
    current = output;
  }
  args.push("-filter_complex", `${filterParts.join(";")};[${current}]aresample=async=1[out]`, "-map", "[out]", "-c:a", "aac", "-b:a", "192k", outputPath);
  await run("ffmpeg", args);
}

export async function applyAudioFades(inputPath: string, durationMs: number, fadeInMs: number, fadeOutMs: number, outputPath: string): Promise<void> {
  const filters: string[] = [];
  if (fadeInMs > 0) filters.push(`afade=t=in:st=0:d=${(fadeInMs / 1000).toFixed(3)}`);
  if (fadeOutMs > 0) filters.push(`afade=t=out:st=${Math.max(0, (durationMs - fadeOutMs) / 1000).toFixed(3)}:d=${(fadeOutMs / 1000).toFixed(3)}`);
  if (!filters.length) { await copyFile(inputPath, outputPath); return; }
  await run("ffmpeg", ["-y", "-i", inputPath, "-af", filters.join(","), "-c:a", "aac", "-b:a", "192k", outputPath]);
}
