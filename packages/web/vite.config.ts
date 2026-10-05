import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { viteSingleFile } from "vite-plugin-singlefile";

// One self-contained HTML file: the simulator runs entirely in the browser.
export default defineConfig({
  plugins: [react(), viteSingleFile()],
  build: { target: "es2022", chunkSizeWarningLimit: 2_000 },
});
