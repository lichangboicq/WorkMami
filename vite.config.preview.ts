import { defineConfig, mergeConfig } from "vite";
import base from "./vite.config";

export default mergeConfig(base, defineConfig({
  server: { port: 1420, strictPort: true, host: "127.0.0.1" },
  cacheDir: ".workbuddy/vite-cache",
}));
