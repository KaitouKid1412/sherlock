import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

export default defineConfig({
  plugins: [react()],
  root: "web",
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: "http://localhost:7777",
        changeOrigin: true,
      },
    },
  },
  resolve: {
    alias: {
      "@/types": path.resolve(__dirname, "types"),
    },
  },
  build: {
    outDir: "../dist",
    emptyOutDir: true,
  },
});
