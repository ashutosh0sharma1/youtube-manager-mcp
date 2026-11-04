import test from "node:test";
import assert from "node:assert/strict";
import { parseYouTubeVideoId } from "../dist/shorts/media.js";
import { applySubmission, createManifest } from "../dist/shorts/store.js";
import { renderSelectorHtml } from "../dist/shorts/selector-template.js";
import { validateSubmission } from "../dist/shorts/validation.js";

function fixtureManifest() {
  const manifest = createManifest("sbs", "fixture-batch");
  manifest.sources = [{
    sourceId: "abc12345678",
    videoId: "abc12345678",
    youtubeUrl: "https://www.youtube.com/watch?v=abc12345678",
    title: "A devotional song",
    durationMs: 30_000,
    audioPath: "C:/fixture/song.m4a",
    infoPath: "C:/fixture/song.info.json",
    previewPath: "C:/fixture/song-preview.m4a",
    waveformPath: "C:/fixture/song-waveform.json",
    sha256: "fixture",
    preparedAt: new Date().toISOString(),
  }];
  return manifest;
}

test("parses supported YouTube URL forms and rejects playlists", () => {
  assert.equal(parseYouTubeVideoId("https://www.youtube.com/watch?v=abc12345678"), "abc12345678");
  assert.equal(parseYouTubeVideoId("https://youtu.be/abc12345678?t=12"), "abc12345678");
  assert.equal(parseYouTubeVideoId("https://youtube.com/shorts/abc12345678"), "abc12345678");
  assert.throws(() => parseYouTubeVideoId("https://www.youtube.com/playlist?list=abc12345678"));
});

test("validates exact audio boundaries and loop constraints", () => {
  const manifest = fixtureManifest();
  const valid = [{ sourceId: "abc12345678", startMs: 1_000, endMs: 8_000, loopCount: 2, crossfadeMs: 100 }];
  assert.deepEqual(validateSubmission(manifest, valid), []);
  assert.ok(validateSubmission(manifest, [{ ...valid[0], endMs: 40_000 }]).some((issue) => issue.field === "endMs"));
  assert.ok(validateSubmission(manifest, [{ ...valid[0], crossfadeMs: 4_000 }]).some((issue) => issue.field === "crossfadeMs"));
});

test("submission creates deterministic short ids and preserves the related video", () => {
  const manifest = fixtureManifest();
  const shorts = applySubmission(manifest, [{ sourceId: "abc12345678", startMs: 1_000, endMs: 8_000, relatedVideoId: "abc12345678" }]);
  assert.equal(shorts[0].id, "abc12345678-01");
  assert.equal(shorts[0].relatedVideoId, "abc12345678");
  assert.equal(shorts[0].status, "audio-approved");
});

test("selector HTML escapes metadata and exposes range controls", () => {
  const manifest = fixtureManifest();
  const html = renderSelectorHtml(manifest, { batchId: manifest.batchId, sources: [{ sourceId: "abc12345678", title: "<unsafe>", durationMs: 30_000, previewUrl: "/media/a/preview", waveform: { sampleRate: 50, peaks: [] } }] });
  assert.match(html, /type="range"/);
  assert.match(html, /const DATA=/);
  assert.ok(!html.includes("<unsafe>"));
});
