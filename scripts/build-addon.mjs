// Builds the Anki add-on: bundles the card maker page into addon/web/, then zips addon/ into
// dist-addon/next-gen-card-creator.ankiaddon (double-click it, or upload it to AnkiWeb).
// `node scripts/build-addon.mjs --link` also links addon/ into your Anki add-ons folder,
// so a restart of Anki picks up each new build.
//
// The page is the website's own app/page.tsx. A few modules only work on a server, so the
// bundle swaps each for its Anki version in addon/src/anki/ (see SWAPS).

import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { build } from "esbuild";
import JSZip from "jszip";

const root = path.resolve(import.meta.dirname, "..");
const addon = path.join(root, "addon");
const anki = path.join(addon, "src", "anki");
const web = path.join(addon, "web");

/** Module (without extension) → its add-on version. */
const SWAPS = new Map([
  [path.join(root, "app", "backend"), path.join(anki, "backend.ts")],
  [path.join(root, "lib", "store"), path.join(anki, "store.ts")],
  [path.join(root, "lib", "collection"), path.join(anki, "collection.ts")],
  [path.join(root, "lib", "config"), path.join(anki, "config.ts")],
  [path.join(root, "lib", "fetch-page"), path.join(anki, "fetch-page.ts")],
]);

const swapForAnki = {
  name: "swap-for-anki",
  setup(b) {
    b.onResolve({ filter: /^node:async_hooks$/ }, () => ({ path: path.join(anki, "async-hooks.ts") }));
    b.onResolve({ filter: /^(\.{1,2}\/|@\/)/ }, (args) => {
      const target = args.path.startsWith("@/")
        ? path.join(root, args.path.slice(2))
        : path.resolve(path.dirname(args.importer), args.path);
      const swap = SWAPS.get(target.replace(/\.tsx?$/, ""));
      return swap && swap !== args.importer ? { path: swap } : undefined;
    });
  },
};

rmSync(web, { recursive: true, force: true });
mkdirSync(web, { recursive: true });

await build({
  entryPoints: [path.join(addon, "src", "main.tsx")],
  outfile: path.join(web, "main.js"),
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "chrome120",
  jsx: "automatic",
  plugins: [swapForAnki],
  define: {
    "process.env.NODE_ENV": '"production"',
    "process.env.NGCC_ADDON": '"1"',
    "process.env.VERCEL": "undefined",
    "process.env.GEMINI_API_KEY": "undefined",
    "process.env.OPENROUTER_API_KEY": "undefined",
  },
  // mupdf's loader mentions Node modules on a path the browser never takes.
  external: ["module", "fs", "path", "url", "node:fs", "node:path", "node:url", "node:module"],
  // Any other process.env read finds nothing rather than failing.
  banner: { js: "globalThis.process ??= { env: {} };" },
  minify: true,
  logLevel: "warning",
  // The page is a Next.js client component; the directive means nothing here.
  logOverride: { "unsupported-directive": "silent" },
});
cpSync(path.join(addon, "src", "index.html"), path.join(web, "index.html"));
// The OpenRouter key steps' screenshots; the page asks for them next to itself.
cpSync(path.join(root, "public", "key-steps"), path.join(web, "key-steps"), { recursive: true });
cpSync(path.join(root, "node_modules", "mupdf", "dist", "mupdf-wasm.wasm"), path.join(web, "mupdf-wasm.wasm"));

// The .ankiaddon is a zip of the add-on folder's contents, without the sources or Anki's own
// files (meta.json holds the user's keys; user_files their lectures).
const skip = new Set(["src", "__pycache__", "meta.json", "user_files"]);
const zip = new JSZip();
(function add(dir, prefix) {
  for (const name of readdirSync(dir)) {
    if (skip.has(name)) continue;
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) add(full, `${prefix}${name}/`);
    else zip.file(`${prefix}${name}`, readFileSync(full));
  }
})(addon, "");
// Anki shows human_version in its add-ons list; it is the app's own version.
const { version } = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
const manifest = JSON.parse(readFileSync(path.join(addon, "manifest.json"), "utf8"));
zip.file("manifest.json", JSON.stringify({ ...manifest, human_version: version }, null, 2));
zip.file("LICENSE", readFileSync(path.join(root, "LICENSE")));
zip.file("NOTICE", readFileSync(path.join(root, "NOTICE")));
mkdirSync(path.join(root, "dist-addon"), { recursive: true });
const out = path.join(root, "dist-addon", "next-gen-card-creator.ankiaddon");
writeFileSync(out, await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }));
console.log(`Built ${path.relative(root, out)}`);

if (process.argv.includes("--link")) {
  const base = process.env.APPDATA && path.join(process.env.APPDATA, "Anki2", "addons21");
  if (!base || !existsSync(base)) throw new Error("Anki's add-ons folder wasn't found.");
  const target = path.join(base, "next_gen_card_creator");
  if (existsSync(target)) console.log(`Already linked: ${target}`);
  else {
    // A junction needs no admin rights on Windows.
    execFileSync("cmd", ["/c", "mklink", "/J", target, addon], { stdio: "inherit" });
  }
}
