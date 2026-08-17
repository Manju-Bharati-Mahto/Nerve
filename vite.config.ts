import { defineConfig } from "vite";
import react from "@vitejs/plugin-react-swc";
import path from "path";

// https://vitejs.dev/config/
export default defineConfig(() => ({
  server: {
    host: "::",
    port: 8080,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:3001",
        changeOrigin: true,
      },
      "/uploads": {
        target: "http://127.0.0.1:3001",
        changeOrigin: true,
      },
      // The public portals are served by the API, not by this dev server, and
      // their links are built from location.origin — which is this dev server.
      // Without these the paths hit Vite's SPA fallback and React renders its
      // own 404: the same gap the matching blocks in nginx/nerve.conf close in
      // production.
      "/casting": {
        target: "http://127.0.0.1:3001",
        changeOrigin: true,
      },
      "/request": {
        target: "http://127.0.0.1:3001",
        changeOrigin: true,
      },
    },
    hmr: {
      overlay: false,
    },
  },
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
    dedupe: ["react", "react-dom", "react/jsx-runtime", "react/jsx-dev-runtime"],
  },
}));
