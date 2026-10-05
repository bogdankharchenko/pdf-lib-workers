import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { readFileSync } from "node:fs";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          API_KEY: "test-key",
          MAX_FETCH_BYTES: "1000000",
          // A TTF with Cyrillic, for tests of custom fonts.
          TEST_FONT: readFileSync("test/fixtures/DejaVuSansMono-Oblique.ttf").toString("base64"),
        },
      },
    }),
  ],
});
