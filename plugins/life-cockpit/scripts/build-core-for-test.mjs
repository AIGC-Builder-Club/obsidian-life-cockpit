// `node --test` 跑的是 JS，纯逻辑写在 TS 里，所以先把 src/core 打成一个
// CommonJS 包给测试 require。core 下不允许 import "obsidian"，这里的
// external 只是兜底：真的有人引进来，打包会直接失败，比运行时才发现好。
import esbuild from "esbuild";
import path from "node:path";
import { fileURLToPath } from "node:url";

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

await esbuild.build({
  entryPoints: [path.join(pluginRoot, "src", "core", "index.ts")],
  bundle: true,
  format: "cjs",
  target: "es2022",
  platform: "node",
  outfile: path.join(pluginRoot, "test", ".build", "core.js"),
  logLevel: "warning",
});

console.log("Built test/.build/core.js from src/core/index.ts.");
