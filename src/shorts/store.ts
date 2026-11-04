import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { BatchManifest, SelectorSubmission, ShortItem } from "./types.js";

export const shortsRoot = path.join(process.cwd(), "output", "shorts");

export function safeSegment(value: string, label = "identifier"): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,95}$/.test(value)) {
    throw new Error(`${label} contains unsupported characters.`);
  }
  return value;
}

export function newBatchId(): string {
  const date = new Date().toISOString().slice(0, 10);
  return `shivala-${date}-${randomUUID().slice(0, 8)}`;
}

export function batchDir(batchId: string): string {
  return path.join(shortsRoot, safeSegment(batchId, "batch_id"));
}

export function batchManifestPath(batchId: string): string {
  return path.join(batchDir(batchId), "manifests", "current.json");
}

export function batchPath(batchId: string, ...parts: string[]): string {
  const root = batchDir(batchId);
  const resolved = path.resolve(root, ...parts);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    throw new Error("Requested batch path escapes the batch directory.");
  }
  return resolved;
}

export async function ensureBatchDirs(batchId: string): Promise<void> {
  await Promise.all([
    mkdir(batchPath(batchId, "sources"), { recursive: true }),
    mkdir(batchPath(batchId, "proxies"), { recursive: true }),
    mkdir(batchPath(batchId, "waveform"), { recursive: true }),
    mkdir(batchPath(batchId, "manifests", "revisions"), { recursive: true }),
    mkdir(batchPath(batchId, "loop-tests"), { recursive: true }),
    mkdir(batchPath(batchId, "previews"), { recursive: true }),
    mkdir(batchPath(batchId, "finals"), { recursive: true }),
    mkdir(batchPath(batchId, "remotion-public"), { recursive: true }),
  ]);
}

async function atomicJsonWrite(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, filePath);
}

export async function writeManifest(manifest: BatchManifest, revisionLabel?: string): Promise<string> {
  manifest.updatedAt = new Date().toISOString();
  await ensureBatchDirs(manifest.batchId);
  const currentPath = batchManifestPath(manifest.batchId);
  await atomicJsonWrite(currentPath, manifest);
  const label = revisionLabel ?? `revision-${Date.now()}`;
  const revisionPath = batchPath(manifest.batchId, "manifests", "revisions", `${safeSegment(label, "revision")}.json`);
  await atomicJsonWrite(revisionPath, manifest);
  if (!manifest.revisions.includes(revisionPath)) manifest.revisions.push(revisionPath);
  // Write the current manifest again so the revision index is included in it.
  await atomicJsonWrite(currentPath, manifest);
  return revisionPath;
}

export async function readManifest(batchId: string): Promise<BatchManifest> {
  const raw = await readFile(batchManifestPath(batchId), "utf8");
  const parsed = JSON.parse(raw) as BatchManifest;
  if (parsed.schemaVersion !== 1 || parsed.batchId !== batchId) throw new Error("Invalid Shorts manifest.");
  return parsed;
}

export function createManifest(channelAlias: string, batchId = newBatchId()): BatchManifest {
  const now = new Date().toISOString();
  return {
    schemaVersion: 1,
    batchId,
    channelAlias,
    createdAt: now,
    updatedAt: now,
    status: "draft",
    sources: [],
    shorts: [],
    revisions: [],
  };
}

function defaultShortId(sourceId: string): string {
  return `${sourceId}-01`;
}

export function applySubmission(manifest: BatchManifest, submissions: SelectorSubmission[]): ShortItem[] {
  const sourceById = new Map(manifest.sources.map((source) => [source.sourceId, source]));
  const next = submissions.map((submission) => {
    const source = sourceById.get(submission.sourceId);
    if (!source) throw new Error(`Unknown source_id: ${submission.sourceId}`);
    const id = defaultShortId(source.sourceId);
    const prior = manifest.shorts.find((item) => item.id === id);
    return {
      id,
      sourceId: source.sourceId,
      audioEdit: {
        startMs: submission.startMs,
        endMs: submission.endMs,
        loopCount: submission.loopCount ?? 1,
        crossfadeMs: submission.crossfadeMs ?? 0,
        fadeInMs: submission.fadeInMs ?? 0,
        fadeOutMs: submission.fadeOutMs ?? 0,
      },
      relatedVideoId: submission.relatedVideoId || source.videoId,
      creativeNotes: submission.creativeNotes ?? "",
      template: submission.template ?? "devotional-artwork",
      title: submission.title || source.title,
      subtitle: submission.subtitle,
      accentColor: submission.accentColor ?? "#f6c453",
      status: "audio-approved" as const,
      revision: (prior?.revision ?? 0) + 1,
      submittedAt: new Date().toISOString(),
      previewPath: undefined,
      finalPath: undefined,
      lastError: undefined,
    } satisfies ShortItem;
  });
  return next;
}
