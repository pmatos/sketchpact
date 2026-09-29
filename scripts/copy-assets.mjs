import { cpSync, mkdirSync } from "node:fs";

const src = "node_modules/@excalidraw/excalidraw/dist/prod/fonts";
const dest = "src/web/public/excalidraw-assets/fonts";
mkdirSync(dest, { recursive: true });
cpSync(src, dest, { recursive: true });
