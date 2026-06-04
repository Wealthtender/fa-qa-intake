import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// In dev (`npm run dev`), Vite serves the UI on :5173 and proxies /api
// calls to the Express backend on :3000 (`npm run start` in another tab).
// In production, Express serves the built /dist and the /api routes together.
export default defineConfig({
  plugins: [react()],
  build: { outDir: "dist" },
  server: {
    proxy: {
      "/api": "http://localhost:3000",
    },
  },
});
