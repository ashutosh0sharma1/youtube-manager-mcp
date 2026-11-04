import { registerRoot } from "remotion";
// Remotion's webpack entry resolves the TSX extension; NodeNext's emitted code is not used here.
// @ts-ignore TS2835: the Remotion bundler resolves this extensionless source import.
import { RemotionRoot } from "./Root";

registerRoot(RemotionRoot);
