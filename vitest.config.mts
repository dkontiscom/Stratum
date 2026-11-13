import { defineConfig } from "vitest/config";
import { cloudflareTest } from "@cloudflare/vitest-plugin";

// Workers Vitest integration (the maintained @cloudflare/vitest-plugin). Boots Miniflare
// from wrangler.jsonc so tests run inside the real Workers runtime with the D1 binding.
export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
    }),
  ],
});
