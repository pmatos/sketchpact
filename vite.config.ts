import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const target = `http://127.0.0.1:${process.env.SKETCHPACT_PORT ?? 3210}`;

export default defineConfig({
  root: "src/web",
  plugins: [react()],
  define: { "process.env.IS_PREACT": JSON.stringify("false") },
  build: { outDir: "../../dist/web", emptyOutDir: true },
  server: {
    host: "127.0.0.1",
    proxy: { "/api": target, "/ws": { target, ws: true } },
  },
});
