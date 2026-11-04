import React, { useEffect, useState } from "react";
import {
  AbsoluteFill, Audio, Img, cancelRender, continueRender, delayRender,
  interpolate, staticFile, useCurrentFrame, useVideoConfig,
} from "remotion";

export type DevotionalIdentity = "devi" | "hanuman" | "radha" | "deep" | "purna" | "navgrah";

/** Beat times are seconds relative to the beginning of the finished Short. */
export interface DevotionalBeat {
  start: number;
  end: number;
  label?: string;
  lines: string[];
  translation?: string;
}

export interface DevotionalPortraitProps {
  [key: string]: unknown;
  id: DevotionalIdentity;
  audioFile: string;
  artworkFile: string;
  durationInFrames: number;
  hook: string[];
  beats: DevotionalBeat[];
  accent: string;
  fontFile?: string;
  topic?: string;
  hookDuration?: number;
  equation?: string;
  seriesLabel?: string;
  variant?: number;
}

const FONT_FAMILY = "SBS Nirmala";
const FONT_PATH = "shorts/sbs-benchmark-20261014/Nirmala.ttc";
const fontLoads = new Map<string, Promise<void>>();

function loadDevotionalFont(fontFile: string): Promise<void> {
  let loading = fontLoads.get(fontFile);
  if (!loading) {
    loading = (async () => {
      // Load the locally bundled collection before taking any frame. The same
      // checked font is used for every Hindi/Sanskrit glyph, including conjuncts.
      const face = new FontFace(FONT_FAMILY, `url("${staticFile(fontFile)}")`);
      await face.load();
      document.fonts.add(face);
      await document.fonts.load(`60px "${FONT_FAMILY}"`, "श्री राधे हनुमान माता");
      await document.fonts.ready;
    })();
    fontLoads.set(fontFile, loading);
  }
  return loading;
}

const looks: Record<DevotionalIdentity, {
  ink: string; glow: string; shadow: string; warmth: string; objectPosition: string;
  series: string; pan: number;
}> = {
  devi: {
    ink: "#fff5e3", glow: "#efac61", shadow: "#190508", warmth: "#dc7549",
    objectPosition: "50% 43%", series: "शक्ति", pan: 1,
  },
  hanuman: {
    ink: "#fff8e8", glow: "#ffc786", shadow: "#07121b", warmth: "#e58b3d",
    objectPosition: "50% 43%", series: "भक्ति", pan: -1,
  },
  radha: {
    ink: "#fff6ed", glow: "#f9c1be", shadow: "#071c20", warmth: "#acded0",
    objectPosition: "50% 43%", series: "प्रेम", pan: 0.65,
  },
  deep: {
    ink: "#fff5dc", glow: "#ffd38b", shadow: "#170b05", warmth: "#e5a043",
    objectPosition: "50% 43%", series: "दीप वंदना", pan: 0.8,
  },
  purna: {
    ink: "#fff8e8", glow: "#c4caff", shadow: "#0d1025", warmth: "#a3b4ef",
    objectPosition: "50% 43%", series: "शांति पाठ", pan: -0.6,
  },
  navgrah: {
    ink: "#fff6e7", glow: "#ffc482", shadow: "#091422", warmth: "#e99a57",
    objectPosition: "50% 43%", series: "नवग्रह स्मरण", pan: 1,
  },
};

const clamp = { extrapolateLeft: "clamp", extrapolateRight: "clamp" } as const;

const FilmAtmosphere: React.FC<{ id: DevotionalIdentity; accent: string }> = ({ id, accent }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const t = frame / fps;
  const look = looks[id];
  return <AbsoluteFill style={{ pointerEvents: "none", overflow: "hidden" }}>
    <AbsoluteFill style={{
      background: `radial-gradient(ellipse at ${20 + Math.sin(t / 7) * 9}% 22%, ${look.warmth}20 0%, transparent 53%)`,
      mixBlendMode: "screen",
    }} />
    <AbsoluteFill style={{
      background: `radial-gradient(ellipse at 95% 72%, ${look.glow}11 0%, transparent 54%)`,
      mixBlendMode: "screen",
    }} />
    {Array.from({ length: 22 }, (_, i) => {
      const x = 54 + ((i * 193.29 + Math.sin(t / 4 + i) * 23) % 990);
      const y = ((i * 171.73 - t * (8 + i % 5) + 2500) % 2200) - 180;
      const size = i % 5 === 0 ? 5 : 2 + i % 3;
      const opacity = (0.14 + (Math.sin(t * 0.8 + i * 1.6) + 1) * 0.11) * (i % 3 === 0 ? 1 : 0.6);
      return <div key={i} style={{
        position: "absolute", left: x, top: y, width: size, height: size,
        background: accent, opacity, borderRadius: "50%",
        boxShadow: `0 0 ${size * 4}px ${accent}99`,
        filter: i % 5 === 0 ? "blur(1.1px)" : undefined,
      }} />;
    })}
  </AbsoluteFill>;
};

const LyricBeat: React.FC<{ beat: DevotionalBeat; accent: string; ink: string }> = ({ beat, accent, ink }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const t = frame / fps;
  const entrance = interpolate(t, [beat.start, beat.start + 0.18], [0, 1], clamp);
  const exit = interpolate(t, [beat.end - 0.12, beat.end], [1, 0], clamp);
  const longest = Math.max(1, ...beat.lines.map((line) => Array.from(line).length));
  const fontSize = longest > 42 ? 42 : longest > 33 ? 47 : longest > 26 ? 53 : 61;
  return <div style={{
    position: "absolute", top: 1188, left: 90, width: 810, textAlign: "center",
    opacity: entrance * exit, transform: `translateY(${(1 - entrance) * 8}px)`,
  }}>
    {beat.label ? <div style={{
      fontSize: 24, lineHeight: 1.5, fontWeight: 600, color: accent,
      marginBottom: 22, letterSpacing: 0.6,
    }}>{beat.label}</div> : <div style={{ height: 47 }} />}
    <div style={{
      color: ink, fontSize, fontWeight: 700, lineHeight: 1.43,
      textShadow: "0 3px 24px #000c, 0 1px 4px #0009",
    }}>
      {beat.lines.map((line, i) => <div key={`${i}-${line}`} style={{ whiteSpace: "nowrap" }}>{line}</div>)}
    </div>
    {beat.translation ? <div style={{
      marginTop: 23, maxWidth: 770, marginLeft: "auto", marginRight: "auto",
      color: "#fff7e6d9", fontSize: 29, lineHeight: 1.5, fontWeight: 400,
      textShadow: "0 2px 18px #000e",
    }}>{beat.translation}</div> : null}
  </div>;
};

export const DevotionalPortrait: React.FC<DevotionalPortraitProps> = (props) => {
  const [fontHandle] = useState(() => delayRender("Load bundled Devanagari font"));
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();
  const look = looks[props.id];
  const fontFile = props.fontFile || FONT_PATH;
  useEffect(() => {
    let active = true;
    loadDevotionalFont(fontFile).then(() => { if (active) continueRender(fontHandle); })
      .catch((error: unknown) => cancelRender(error instanceof Error ? error : new Error(String(error))));
    return () => { active = false; };
  }, [fontFile, fontHandle]);

  const progress = frame / Math.max(1, durationInFrames - 1);
  const t = frame / fps;
  // A complete cosine camera arc returns to the opening composition at the loop.
  const cameraArc = (1 - Math.cos(progress * Math.PI * 2)) / 2;
  const scale = 1.035 + cameraArc * 0.043;
  const panX = Math.sin(progress * Math.PI * 2) * 11 * look.pan * ((props.variant ?? 0) % 2 ? -1 : 1);
  const panY = cameraArc * -13;
  const hookSize = Math.max(...props.hook.map((line) => Array.from(line).length), 1) > 23 ? 63 : 73;
  const activeBeats = props.beats.filter((beat) => t >= beat.start && t < beat.end);
  const hookDuration = props.hookDuration ?? 4;
  const seconds = durationInFrames / fps;
  const hookDeparture = interpolate(t, [Math.max(0, hookDuration - 0.25), hookDuration], [1, 0], clamp);
  const hookReturn = interpolate(t, [Math.max(hookDuration, seconds - 2.25), Math.max(hookDuration + 0.01, seconds - 2)], [0, 1], clamp);
  const hookOpacity = Math.max(hookDeparture, hookReturn);
  const equationOpacity = interpolate(t, [hookDuration, hookDuration + 0.6], [0, 1], clamp);

  return <AbsoluteFill style={{
    overflow: "hidden", background: look.shadow, color: look.ink,
    fontFamily: `"${FONT_FAMILY}", "Nirmala UI", sans-serif`,
  }}>
    {props.audioFile ? <Audio src={staticFile(props.audioFile)} /> : null}
    <AbsoluteFill style={{ transform: `translate(${panX}px, ${panY}px) scale(${scale})` }}>
      <Img src={staticFile(props.artworkFile)} style={{
        width: "100%", height: "100%", objectFit: "cover", objectPosition: look.objectPosition,
      }} />
    </AbsoluteFill>
    <AbsoluteFill style={{ background: `linear-gradient(180deg, ${look.shadow}a6 0%, ${look.shadow}50 20%, transparent 34%, transparent 49%, ${look.shadow}4d 57%, ${look.shadow}eb 73%, ${look.shadow} 92%)` }} />
    <AbsoluteFill style={{ background: "linear-gradient(90deg, #00000024 0%, transparent 18%, transparent 75%, #0000003b 100%)" }} />
    <FilmAtmosphere id={props.id} accent={props.accent} />

    <div style={{ position: "absolute", left: 90, top: 159, width: 810, textAlign: "center" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 19, marginBottom: 29 }}>
        <span style={{ width: 47, height: 1, background: `${props.accent}99` }} />
        <span style={{ color: props.accent, fontSize: 24, letterSpacing: 1.4, fontWeight: 600 }}>{props.seriesLabel || look.series}</span>
        <span style={{ width: 47, height: 1, background: `${props.accent}99` }} />
      </div>
      <div style={{
        fontSize: hookSize, fontWeight: 700, lineHeight: 1.34, letterSpacing: -0.7,
        textShadow: "0 4px 30px #000c, 0 1px 4px #0008",
        opacity: hookOpacity,
      }}>
        {props.hook.map((line, i) => <div key={`${i}-${line}`} style={{ whiteSpace: "nowrap" }}>{line}</div>)}
      </div>
      <div style={{
        position: "absolute", top: 77, left: 0, width: "100%", textAlign: "center",
        fontSize: 39, fontWeight: 600, lineHeight: 1.4, opacity: 1 - hookOpacity,
        textShadow: "0 3px 25px #000c",
      }}>{props.topic || look.series}</div>
    </div>

    {props.equation ? <div style={{
      position: "absolute", top: 937, left: 90, width: 810, padding: "14px 0 20px",
      textAlign: "center", fontSize: 69, lineHeight: 1.4, fontWeight: 600,
      color: look.ink, opacity: equationOpacity * (1 - hookReturn),
      textShadow: `0 3px 30px ${look.shadow}, 0 0 60px ${look.glow}55`,
      transform: `translateY(${(1 - equationOpacity) * 9}px)`,
    }}>{props.equation}</div> : null}

    {activeBeats.map((beat, i) => <LyricBeat key={`${beat.start}-${i}`} beat={beat} accent={props.accent} ink={look.ink} />)}

    <div style={{ position: "absolute", top: 1531, left: 90, width: 810, textAlign: "center" }}>
      <div style={{ width: 44, height: 1, background: `${props.accent}aa`, margin: "0 auto 15px" }} />
      <div style={{
        fontFamily: "Georgia, serif", fontSize: 19, lineHeight: 1.3,
        color: "#fff5e3c2", letterSpacing: 3.1,
      }}>SHIVALA BHAKTI SAGAR</div>
    </div>
  </AbsoluteFill>;
};
