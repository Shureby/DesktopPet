import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

// Tauri expects a fixed port and must not clear its console output.
export default defineConfig({
  clearScreen: false,
  server: { port: 1420, strictPort: true },
  envPrefix: ["VITE_", "TAURI_ENV_"],
  build: {
    target: "es2022",
    rollupOptions: {
      input: {
        pet: resolve(import.meta.dirname, "pet.html"),
        panel: resolve(import.meta.dirname, "panel.html"),
        game: resolve(import.meta.dirname, "game.html"),
        celebrate: resolve(import.meta.dirname, "celebrate.html"),
      },
    },
  },
  test: {
    include: ["src/**/*.test.ts"],
  },
});
