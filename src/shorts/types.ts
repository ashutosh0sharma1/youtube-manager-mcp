export type ShortStatus =
  | "draft"
  | "sources-ready"
  | "audio-approved"
  | "concept-approved"
  | "preview-rendered"
  | "final-approved"
  | "final-rendered"
  | "uploaded-private"
  | "related-video-set"
  | "published";

export interface SourceAsset {
  sourceId: string;
  videoId: string;
  youtubeUrl: string;
  title: string;
  channelTitle?: string;
  durationMs: number;
  thumbnailUrl?: string;
  audioPath: string;
  infoPath: string;
  previewPath: string;
  waveformPath: string;
  sha256: string;
  preparedAt: string;
}

export interface AudioEdit {
  startMs: number;
  endMs: number;
  loopCount: number;
  crossfadeMs: number;
  fadeInMs: number;
  fadeOutMs: number;
}

export interface ShortItem {
  id: string;
  sourceId: string;
  audioEdit: AudioEdit;
  relatedVideoId: string;
  creativeNotes: string;
  template: "devotional-artwork" | "mantra-lyrics" | "temple-cinematic" | "minimal-visualizer";
  title?: string;
  subtitle?: string;
  accentColor?: string;
  status: ShortStatus;
  revision: number;
  submittedAt?: string;
  previewPath?: string;
  finalPath?: string;
  lastError?: string;
}

export interface BatchManifest {
  schemaVersion: 1;
  batchId: string;
  channelAlias: string;
  createdAt: string;
  updatedAt: string;
  status: "draft" | "sources-ready" | "audio-approved" | "rendered" | "uploaded";
  sources: SourceAsset[];
  shorts: ShortItem[];
  revisions: string[];
}

export interface SelectorSubmission {
  sourceId: string;
  startMs: number;
  endMs: number;
  loopCount?: number;
  crossfadeMs?: number;
  fadeInMs?: number;
  fadeOutMs?: number;
  relatedVideoId?: string;
  creativeNotes?: string;
  template?: ShortItem["template"];
  title?: string;
  subtitle?: string;
  accentColor?: string;
}

export interface RenderResult {
  shortId: string;
  kind: "loop-test" | "preview" | "final";
  outputPath: string;
  durationMs: number;
  width?: number;
  height?: number;
  fps?: number;
  audioPath?: string;
}
