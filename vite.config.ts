import { defineConfig } from "vite";

export default defineConfig({
  base: "./",
  clearScreen: false,
  server: {
    host: "127.0.0.1",
    port: 43123,
    strictPort: true,
  },
  preview: {
    host: "127.0.0.1",
    port: 43123,
    strictPort: true,
  },
  build: {
    target: "es2021",
    outDir: "dist",
    emptyOutDir: true,
    cssCodeSplit: false,
    sourcemap: false,
    minify: "esbuild",
  },
});
