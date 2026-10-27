import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/testing.ts"],
  format: ["esm", "cjs"],
  target: "node20",
  platform: "node",
  dts: true,
  clean: true,
  sourcemap: true,
  removeNodeProtocol: false,
});
