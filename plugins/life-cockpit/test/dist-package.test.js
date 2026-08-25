import assert from "node:assert/strict";
import test from "node:test";
import esbuild from "esbuild";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

// `dist/life-cockpit/` 是**仓库主人真正装进 Obsidian 的那一份**。
// 源码在 `plugins/life-cockpit/`，中间隔着两步：`npm run build` 打出 main.js，
// 再 `node scripts/update-life-cockpit-package.mjs` 同步到 dist。
//
// 这两步都是手动的，而漏掉它们**不会有任何报错**——PR 里源码改得好好的、
// 测试全绿、review 也看不出问题，只有装插件的人看到的还是旧版本。
// 这件事已经真的发生过一次（#58 改了源码，dist 停在 #44）。
//
// 所以这一条守的不是代码对不对，是**交付的那一份和源码是不是同一份**。

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distRoot = path.resolve(pluginRoot, "../../dist/life-cockpit");

const STALE_HINT = "在 plugins/life-cockpit 下跑 `npm run build`，"
  + "再在仓库根跑 `node scripts/update-life-cockpit-package.mjs`，然后提交 dist/。";

/** 不经过构建就能比的两个：它们本身就是源文件，逐字节对齐即可。 */
for (const file of ["styles.css", "manifest.json"]) {
  test(`dist 里的 ${file} 和源没有分叉`, async () => {
    const [source, shipped] = await Promise.all([
      readFile(path.join(pluginRoot, file), "utf8"),
      readFile(path.join(distRoot, file), "utf8"),
    ]);
    assert.equal(shipped, source, `dist/life-cockpit/${file} 过期了：${STALE_HINT}`);
  });
}

test("dist 里的 main.js 和源没有分叉 —— 改了插件就要重新打包", async () => {
  // 只跑 esbuild，不跑 tsc：类型有没有错是别的测试的事，
  // 这里只问「打出来的字节和交付的那份一不一样」。
  // 选项必须和 esbuild.config.mjs 的 production 分支逐条一致，
  // 否则这条测试会因为构建口径不同而误报——那比不测还糟。
  const result = await esbuild.build({
    absWorkingDir: pluginRoot,
    entryPoints: ["src/main.ts"],
    bundle: true,
    external: ["obsidian", "electron", "@codemirror/*", "@lezer/*"],
    format: "cjs",
    target: "es2022",
    jsx: "automatic",
    define: { "process.env.NODE_ENV": '"production"' },
    platform: "browser",
    sourcemap: false,
    treeShaking: true,
    minify: true,
    logLevel: "error",
    write: false,
  });

  const fresh = result.outputFiles[0].text;
  const shipped = await readFile(path.join(distRoot, "main.js"), "utf8");
  assert.equal(
    shipped.length,
    fresh.length,
    `dist/life-cockpit/main.js 过期了（交付 ${shipped.length} 字节，源应打出 ${fresh.length} 字节）：${STALE_HINT}`,
  );
  assert.equal(shipped, fresh, `dist/life-cockpit/main.js 过期了：${STALE_HINT}`);
});
