import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const target = "http://localhost:8787";

const proxy = {
  "/api": { target, changeOrigin: true },
  "/game": { target, changeOrigin: true, ws: true },
  "/mcp": { target, changeOrigin: true },
};

export default defineConfig({
  plugins: [react()],
  server: { port: 5173, strictPort: true, proxy },
  preview: { port: 4173, proxy },
});
