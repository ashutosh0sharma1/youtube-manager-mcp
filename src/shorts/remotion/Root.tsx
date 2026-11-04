import React from "react";
import { AbsoluteFill, Audio, Composition, Img, interpolate, staticFile, useCurrentFrame, useVideoConfig } from "remotion";

export interface ShivalaCompositionProps {
  [key: string]: unknown;
  audioFile: string;
  durationInFrames: number;
  title: string;
  subtitle?: string;
  channelName: string;
  accentColor: string;
  template: "devotional-artwork" | "mantra-lyrics" | "temple-cinematic" | "minimal-visualizer";
  thumbnailUrl?: string;
  preview?: boolean;
}

const defaultProps: ShivalaCompositionProps = {
  audioFile: "audio.m4a",
  durationInFrames: 1800,
  title: "Shivala Bhakti Sagar",
  subtitle: "",
  channelName: "Shivala Bhakti Sagar",
  accentColor: "#f6c453",
  template: "devotional-artwork",
  preview: false,
};

const backgrounds: Record<ShivalaCompositionProps["template"], string> = {
  "devotional-artwork": "radial-gradient(circle at 50% 30%, #73531c 0%, #24170b 42%, #090807 100%)",
  "mantra-lyrics": "radial-gradient(circle at 50% 45%, #394a54 0%, #12191d 44%, #080909 100%)",
  "temple-cinematic": "linear-gradient(145deg, #422113 0%, #160e0c 52%, #050505 100%)",
  "minimal-visualizer": "linear-gradient(145deg, #252018 0%, #0b0b0a 60%, #050505 100%)",
};

const Visualizer: React.FC<{ color: string }> = ({ color }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 10, height: 170, opacity: 0.9 }}>
      {Array.from({ length: 18 }, (_, index) => {
        const wave = Math.sin(frame / (fps * 0.45) + index * 0.75) * 0.5 + 0.5;
        const height = 26 + wave * 104;
        return <div key={index} style={{ width: 9, height, borderRadius: 8, background: color, boxShadow: `0 0 18px ${color}55` }} />;
      })}
    </div>
  );
};

const ShivalaShort: React.FC<ShivalaCompositionProps> = (props) => {
  const frame = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();
  const progress = interpolate(frame, [0, durationInFrames], [0, 1], { extrapolateRight: "clamp" });
  const scale = 1 + progress * 0.055;
  return (
    <AbsoluteFill style={{ background: backgrounds[props.template], color: "#fff7e6", fontFamily: "Arial, Noto Sans Devanagari, sans-serif", overflow: "hidden" }}>
      <Audio src={staticFile(props.audioFile)} />
      <AbsoluteFill style={{ transform: `scale(${scale})`, opacity: 0.95 }}>
        <div style={{ position: "absolute", inset: 0, background: `radial-gradient(circle at 50% 35%, ${props.accentColor}33, transparent 38%)` }} />
        <div style={{ position: "absolute", width: 820, height: 820, borderRadius: "50%", border: `2px solid ${props.accentColor}55`, top: 310, left: 140, transform: `rotate(${frame / 80}deg)`, boxShadow: `0 0 100px ${props.accentColor}1f` }} />
        <div style={{ position: "absolute", width: 610, height: 610, borderRadius: "50%", border: `1px solid ${props.accentColor}44`, top: 415, left: 245, transform: `rotate(${-frame / 110}deg)` }} />
      </AbsoluteFill>
      <div style={{ position: "absolute", top: 110, left: 90, right: 90, textAlign: "center", letterSpacing: 5, fontSize: 28, color: props.accentColor, fontWeight: 700 }}>ॐ</div>
      <div style={{ position: "absolute", top: 265, left: 80, right: 80, textAlign: "center", fontSize: 54, lineHeight: 1.18, fontWeight: 800, textShadow: `0 4px 30px ${props.accentColor}66` }}>{props.title}</div>
      {props.subtitle ? <div style={{ position: "absolute", top: 420, left: 110, right: 110, textAlign: "center", fontSize: 29, color: "#f6e7c1", opacity: 0.9 }}>{props.subtitle}</div> : null}
      <div style={{ position: "absolute", top: 650, left: 50, right: 50 }}><Visualizer color={props.accentColor} /></div>
      <div style={{ position: "absolute", bottom: 170, left: 70, right: 70, textAlign: "center", fontSize: 27, letterSpacing: 2, color: "#f6e7c1" }}>{props.channelName}</div>
      <div style={{ position: "absolute", bottom: 105, left: 95, right: 95, height: 5, background: "#ffffff2a", borderRadius: 4 }}><div style={{ width: `${progress * 100}%`, height: "100%", background: props.accentColor, borderRadius: 4 }} /></div>
      {props.preview ? <div style={{ position: "absolute", top: 38, right: 35, fontSize: 20, color: "#ffffffaa", letterSpacing: 3 }}>PREVIEW</div> : null}
    </AbsoluteFill>
  );
};

export const RemotionRoot: React.FC = () => (
  <Composition<any, ShivalaCompositionProps>
    id="ShivalaDevotional"
    component={ShivalaShort}
    durationInFrames={defaultProps.durationInFrames}
    fps={30}
    width={1080}
    height={1920}
    defaultProps={defaultProps}
    calculateMetadata={({ props }) => ({ durationInFrames: Math.max(1, Math.round((props as ShivalaCompositionProps).durationInFrames)) })}
  />
);
