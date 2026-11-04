import { registerRoot } from "remotion";
// @ts-ignore TS2835: webpack resolves source TSX for the standalone Remotion entry.
import { BenchmarkRoot } from "./Root";

registerRoot(BenchmarkRoot);
