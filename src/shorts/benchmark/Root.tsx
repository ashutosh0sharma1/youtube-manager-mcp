import React from "react";
import { Composition } from "remotion";
// @ts-ignore TS2835: webpack resolves source TSX for the standalone Remotion entry.
import { DevotionalPortrait } from "./Portrait";
import type { DevotionalPortraitProps } from "./Portrait.js";

const defaultProps: DevotionalPortraitProps = {
  id: "devi",
  audioFile: "",
  artworkFile: "shorts/sbs-benchmark-20261014/devi.png",
  durationInFrames: 750,
  hook: ["एक पल माँ के नाम"],
  beats: [{ start: 0, end: 25, label: "माँ की आरती", lines: ["जय माता दी"] }],
  accent: "#efc280",
};

export const BenchmarkRoot: React.FC = () => <Composition<any, DevotionalPortraitProps>
  id="SBSDevotionalPortrait"
  component={DevotionalPortrait}
  durationInFrames={750}
  fps={30}
  width={1080}
  height={1920}
  defaultProps={defaultProps}
  calculateMetadata={({ props }) => ({
    durationInFrames: Math.max(1, Math.round((props as DevotionalPortraitProps).durationInFrames)),
  })}
/>;
