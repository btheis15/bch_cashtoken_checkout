import path from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const here = path.dirname(fileURLToPath(import.meta.url));
const mod = (name) => path.resolve(here, "node_modules", name);

// The demo runs the kit's own code (../src) and payment screen (../examples/react) in the browser, against a
// simulated network (../test/fakes.mjs) and a simulated wallet. The real network and WalletConnect clients aren't
// needed, so they're left out.
export default defineConfig({
  base: process.env.DEMO_BASE || "/",
  plugins: [react()],
  resolve: {
    alias: {
      "@electrum-cash/network": path.resolve(here, "src/no-electrum.js"),
      "@walletconnect/sign-client": path.resolve(here, "src/no-walletconnect.js"),
      react: mod("react"),
      "react-dom": mod("react-dom"),
      uqr: mod("uqr"),
    },
  },
  server: { fs: { allow: [path.resolve(here, "..")] } },
  build: { outDir: "dist", chunkSizeWarningLimit: 2000 },
});
