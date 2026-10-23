// Builds the desktop app: a self-contained Next.js server, then the installer around it.
//   npm run desktop:build            installer for this computer's system
//   npm run desktop:build -- --dir   an unpacked app folder only (quick check, no installer)

import { spawnSync } from "node:child_process";
import { cpSync, existsSync, rmSync } from "node:fs";

const run = (command, args, env = {}) => {
  const result = spawnSync(command, args, { stdio: "inherit", shell: true, env: { ...process.env, ...env } });
  if (result.status !== 0) process.exit(result.status ?? 1);
};

rmSync(".next", { recursive: true, force: true });
rmSync("dist-desktop", { recursive: true, force: true });

// DESKTOP_BUILD makes Next write .next/standalone; VERCEL is cleared so the website's ad tag stays out.
run("npx", ["next", "build"], { DESKTOP_BUILD: "1", VERCEL: "" });

// The standalone server doesn't copy the static files or public folder itself.
cpSync(".next/static", ".next/standalone/.next/static", { recursive: true });
if (existsSync("public")) cpSync("public", ".next/standalone/public", { recursive: true });

run("npx", ["electron-builder", ...process.argv.slice(2)]);
