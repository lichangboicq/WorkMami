import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Tauri 期望固定端口，且不打开浏览器
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: "127.0.0.1",
  },
  envPrefix: ["VITE_", "TAURI_"],
  build: {
    target: ["es2021", "chrome100", "safari13"],
    minify: !process.env.TAURI_DEBUG ? "esbuild" : false,
    sourcemap: !!process.env.TAURI_DEBUG,
    outDir: "dist",
    // 设计如此：单包体积较大属预期（含 Tauri 运行时 + 全部前端依赖），
    // 关闭 Vite 默认 500kB chunk 体积 WARN，避免 nightly 构建误报。
    chunkSizeWarningLimit: 3000,
    rollupOptions: {
      output: {
        // 设计如此：将 @tauri-apps 运行时依赖集中到独立 chunk，
        // 消除 "@tauri-apps/api/core.js 同时被动态/静态 import" 的冲突告警。
        manualChunks(id) {
          if (id.includes("@tauri-apps")) return "tauri-runtime";
        },
      },
    },
  },
});
