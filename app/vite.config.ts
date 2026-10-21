import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";
// @ts-expect-error plain JS, used only by `npm run dev`
import { devGraphics } from "./dev-graphics.mjs";

// Tauri expects a fixed port and doesn't need Vite's own screen clearing.
export default defineConfig({
  plugins: [react(), devGraphics()],
  clearScreen: false,
  server: { port: 1420, strictPort: true, watch: { ignored: ["**/src-tauri/**", "**/public/fixtures/**"] } },
  build: { target: "safari16", outDir: "dist" },
  test: { include: ["src/**/*.test.ts"] },
});
