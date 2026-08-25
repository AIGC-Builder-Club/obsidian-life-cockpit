import esbuild from "esbuild";

const prod = process.argv.includes("production");

const ctx = await esbuild.context({
  entryPoints: ["src/main.ts"],
  bundle: true,
  external: ["obsidian", "electron", "@codemirror/*", "@lezer/*"],
  format: "cjs",
  target: "es2022",
  // React 走自动 runtime，所以 .tsx 里不用手写 `import React`
  jsx: "automatic",
  // React 会读它决定要不要带上开发期的警告和 profiling 代码。
  // **不定义的话打出来的是 dev 版**：体积翻倍，而且每次渲染都多一堆检查。
  define: { "process.env.NODE_ENV": prod ? '"production"' : '"development"' },
  outfile: "main.js",
  platform: "browser",
  sourcemap: prod ? false : "inline",
  treeShaking: true,
  minify: prod,
  logLevel: "info",
});

if (process.argv.includes("--watch")) {
  await ctx.watch();
  console.log("Watching for changes...");
} else if (prod) {
  await ctx.rebuild();
  await ctx.dispose();
} else {
  await ctx.watch();
  console.log("Watching for changes...");
}
