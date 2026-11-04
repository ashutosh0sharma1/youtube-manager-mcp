import { copyFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { applyAudioFades, concatenateAudio, extractSegment, probeMedia } from "./media.js";
import { batchPath, ensureBatchDirs, readManifest, writeManifest } from "./store.js";
import { validateManifestForRender } from "./validation.js";
import type { BatchManifest, RenderResult, ShortItem } from "./types.js";

const execFileAsync = promisify(execFile);
const FPS = 30;
const projectRoot = process.cwd();

async function runRemotion(outputPath: string, args: string[]): Promise<void> {
  // Launch the CLI's JavaScript entry directly. Node 26 on this Windows host
  // returns EINVAL when execFile is asked to spawn npx.cmd.
  const command = process.execPath;
  const cliEntry = path.join(projectRoot, "node_modules", "@remotion", "cli", "remotion-cli.js");
  try {
    await execFileAsync(command, [cliEntry, "render", "src/shorts/remotion/index.ts", "ShivalaDevotional", outputPath, ...args], {
      cwd: projectRoot,
      windowsHide: true,
      maxBuffer: 32 * 1024 * 1024,
    });
  } catch (error) {
    const detail = error as { stdout?: string; stderr?: string; message?: string };
    throw new Error(`Remotion render failed: ${detail.stderr || detail.stdout || detail.message || String(error)}`);
  }
}

function shortOrThrow(manifest: BatchManifest, shortId: string): { item: ShortItem; source: BatchManifest["sources"][number] } {
  return validateManifestForRender(manifest, shortId);
}

async function makeLoopedSelection(manifest: BatchManifest, shortId: string): Promise<{ item: ShortItem; source: BatchManifest["sources"][number]; loopedPath: string; durationMs: number }> {
  const { item, source } = shortOrThrow(manifest, shortId);
  const edit = item.audioEdit;
  const segmentPath = batchPath(manifest.batchId, "loop-tests", `${shortId}-segment.m4a`);
  const rawLoopedPath = batchPath(manifest.batchId, "loop-tests", `${shortId}-looped-raw.m4a`);
  const loopedPath = batchPath(manifest.batchId, "loop-tests", `${shortId}-looped.m4a`);
  await extractSegment(source.audioPath, edit.startMs, edit.endMs, segmentPath);
  await concatenateAudio(segmentPath, edit.loopCount, edit.crossfadeMs, rawLoopedPath);
  const rawMedia = await probeMedia(rawLoopedPath);
  if (edit.fadeInMs > 0 || edit.fadeOutMs > 0) await applyAudioFades(rawLoopedPath, rawMedia.durationMs, edit.fadeInMs, edit.fadeOutMs, loopedPath);
  else await applyAudioFades(rawLoopedPath, rawMedia.durationMs, 0, 0, loopedPath);
  const media = await probeMedia(loopedPath);
  return { item, source, loopedPath, durationMs: media.durationMs };
}

export async function renderLoopTest(batchId: string, shortId: string): Promise<RenderResult> {
  const manifest = await readManifest(batchId);
  const { item, loopedPath, durationMs } = await makeLoopedSelection(manifest, shortId);
  return { shortId, kind: "loop-test", outputPath: loopedPath, durationMs, audioPath: loopedPath };
}

async function renderShort(batchId: string, shortId: string, kind: "preview" | "final"): Promise<RenderResult> {
  const manifest = await readManifest(batchId);
  await ensureBatchDirs(batchId);
  const { item, source, loopedPath, durationMs } = await makeLoopedSelection(manifest, shortId);
  const publicDir = path.join(projectRoot, "public", "shorts", batchId);
  await mkdir(publicDir, { recursive: true });
  const publicAudioName = `${shortId}-r${item.revision}.m4a`;
  await copyFile(loopedPath, path.join(publicDir, publicAudioName));
  const propsPath = batchPath(batchId, "manifests", `${shortId}-r${item.revision}-${kind}-props.json`);
  const outputPath = batchPath(batchId, kind === "preview" ? "previews" : "finals", `${shortId}-r${item.revision}.mp4`);
  const props = {
    audioFile: `shorts/${batchId}/${publicAudioName}`,
    durationInFrames: Math.max(1, Math.ceil(durationMs / 1000 * FPS)),
    title: item.title || source.title,
    subtitle: item.subtitle || "",
    channelName: manifest.channelAlias === "sbs" ? "Shivala Bhakti Sagar" : manifest.channelAlias,
    accentColor: item.accentColor || "#f6c453",
    template: item.template,
    thumbnailUrl: source.thumbnailUrl,
    preview: kind === "preview",
  };
  const { writeFile } = await import("node:fs/promises");
  await writeFile(propsPath, `${JSON.stringify(props, null, 2)}\n`, "utf8");
  await runRemotion(outputPath, ["--props", propsPath, "--scale", kind === "preview" ? "0.5" : "1", "--codec", "h264"]);
  const media = await probeMedia(outputPath);
  if (kind === "preview") { item.previewPath = outputPath; item.status = "preview-rendered"; }
  else { item.finalPath = outputPath; item.status = "final-rendered"; }
  manifest.status = "rendered";
  await writeManifest(manifest, `${kind}-${shortId}-r${item.revision}-${Date.now()}`);
  return { shortId, kind, outputPath, durationMs: media.durationMs, width: media.width, height: media.height, fps: media.fps, audioPath: loopedPath };
}

export async function renderPreview(batchId: string, shortId: string): Promise<RenderResult> {
  return renderShort(batchId, shortId, "preview");
}

export async function renderFinal(batchId: string, shortId: string): Promise<RenderResult> {
  const manifest = await readManifest(batchId);
  const item = manifest.shorts.find((short) => short.id === shortId);
  if (!item || !["final-approved", "final-rendered"].includes(item.status)) {
    throw new Error("A preview must be rendered and explicitly approved before a final render. Call shorts_approve_final first.");
  }
  return renderShort(batchId, shortId, "final");
}

export async function inspectRender(filePath: string): Promise<Awaited<ReturnType<typeof probeMedia>>> {
  return probeMedia(filePath);
}
