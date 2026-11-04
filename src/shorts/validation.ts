import type { BatchManifest, SelectorSubmission } from "./types.js";

export interface ValidationIssue {
  sourceId?: string;
  field?: string;
  message: string;
}

const templates = new Set(["devotional-artwork", "mantra-lyrics", "temple-cinematic", "minimal-visualizer"]);

export function validateSubmission(manifest: BatchManifest, submissions: SelectorSubmission[]): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const sources = new Map(manifest.sources.map((source) => [source.sourceId, source]));
  const seen = new Set<string>();
  if (submissions.length === 0) issues.push({ message: "Select at least one song before submitting." });
  for (const [index, submission] of submissions.entries()) {
    const source = sources.get(submission.sourceId);
    if (!source) {
      issues.push({ sourceId: submission.sourceId, message: "Source does not exist in this batch." });
      continue;
    }
    if (seen.has(submission.sourceId)) issues.push({ sourceId: submission.sourceId, message: "A source can appear only once in the first workflow version." });
    seen.add(submission.sourceId);
    const start = Number(submission.startMs);
    const end = Number(submission.endMs);
    const loopCount = Number(submission.loopCount ?? 1);
    const crossfadeMs = Number(submission.crossfadeMs ?? 0);
    if (!Number.isFinite(start) || start < 0) issues.push({ sourceId: submission.sourceId, field: "startMs", message: "Start must be zero or greater." });
    if (!Number.isFinite(end) || end <= start) issues.push({ sourceId: submission.sourceId, field: "endMs", message: "End must be after start." });
    if (end > source.durationMs) issues.push({ sourceId: submission.sourceId, field: "endMs", message: `End cannot exceed source duration (${source.durationMs} ms).` });
    if (end - start < 500) issues.push({ sourceId: submission.sourceId, message: "Selection must be at least 500 ms." });
    if (!Number.isInteger(loopCount) || loopCount < 1 || loopCount > 20) issues.push({ sourceId: submission.sourceId, field: "loopCount", message: "Loop count must be an integer from 1 to 20." });
    if (!Number.isFinite(crossfadeMs) || crossfadeMs < 0 || crossfadeMs > (end - start) / 2) issues.push({ sourceId: submission.sourceId, field: "crossfadeMs", message: "Crossfade must be between zero and half the selected segment." });
    for (const field of ["fadeInMs", "fadeOutMs"] as const) {
      const value = Number(submission[field] ?? 0);
      if (!Number.isFinite(value) || value < 0 || value > end - start) issues.push({ sourceId: submission.sourceId, field, message: `${field} must be between zero and the selection duration.` });
    }
    if (submission.template && !templates.has(submission.template)) issues.push({ sourceId: submission.sourceId, field: "template", message: "Unknown Remotion template." });
    if (submission.relatedVideoId && !/^[A-Za-z0-9_-]{6,20}$/.test(submission.relatedVideoId)) issues.push({ sourceId: submission.sourceId, field: "relatedVideoId", message: "Related video ID is not valid." });
    if (index > 9) issues.push({ sourceId: submission.sourceId, message: "A batch may contain at most ten Shorts." });
  }
  return issues;
}

export function assertValidSubmission(manifest: BatchManifest, submissions: SelectorSubmission[]): void {
  const issues = validateSubmission(manifest, submissions);
  if (issues.length) throw new Error(JSON.stringify({ message: "Invalid Shorts selection.", issues }));
}

export function validateManifestForRender(manifest: BatchManifest, shortId: string) {
  const item = manifest.shorts.find((short) => short.id === shortId);
  if (!item) throw new Error(`Short not found: ${shortId}`);
  const source = manifest.sources.find((candidate) => candidate.sourceId === item.sourceId);
  if (!source) throw new Error(`Source not found for Short: ${shortId}`);
  assertValidSubmission(manifest, [{
    sourceId: item.sourceId,
    ...item.audioEdit,
    relatedVideoId: item.relatedVideoId,
    template: item.template,
  }]);
  return { item, source };
}
