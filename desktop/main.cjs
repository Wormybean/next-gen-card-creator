/* eslint-disable @typescript-eslint/no-require-imports -- Electron's main process is plain CommonJS */
// Desktop shell: starts the built Next.js server on this computer and shows it in a window.
// Nothing here talks to the internet except what the app itself does (the AI, readings).

const { app, BrowserWindow, shell, dialog } = require("electron");
const { spawn } = require("node:child_process");
const net = require("node:net");
const path = require("node:path");

// Drafts made before the rename live in the old "Card Maker" data folder, so keep using it.
app.setPath("userData", path.join(app.getPath("appData"), "Card Maker"));

let server = null;

const freePort = () =>
  new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });

async function waitUntilUp(port) {
  for (let i = 0; i < 120; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/config`);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("The Next-gen Card Creator server did not start.");
}

async function startServer() {
  const port = Number(process.env.CARDMAKER_PORT) || (await freePort());
  // The packaged app has the server in resources/server; in development it is the standalone build.
  const root = app.isPackaged
    ? path.join(process.resourcesPath, "server")
    : path.join(__dirname, "..", ".next", "standalone");
  server = spawn(process.execPath, [path.join(root, "server.js")], {
    cwd: root,
    env: {
      ...process.env,
      // Run the server with Electron's own copy of Node, so users need nothing installed.
      ELECTRON_RUN_AS_NODE: "1",
      PORT: String(port),
      HOSTNAME: "127.0.0.1",
      NODE_ENV: "production",
      // Uploads and drafts live in the app's own data folder, outside any synced folder.
      CARDMAKER_DATA: path.join(app.getPath("userData"), "jobs"),
    },
    stdio: "ignore",
    windowsHide: true,
  });
  server.once("exit", () => {
    server = null;
  });
  await waitUntilUp(port);
  return port;
}

async function createWindow() {
  let port;
  try {
    port = await startServer();
  } catch (e) {
    dialog.showErrorBox("Next-gen Card Creator", e.message);
    return app.quit();
  }
  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    title: "Next-gen Card Creator",
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, sandbox: true },
  });
  const own = `http://127.0.0.1:${port}`;
  // Links to other sites (readings, Google AI Studio) open in the normal browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (!url.startsWith(own)) void shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (e, url) => {
    if (!url.startsWith(own)) {
      e.preventDefault();
      void shell.openExternal(url);
    }
  });
  await win.loadURL(`${own}/`);
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on("second-instance", () => {
    const [win] = BrowserWindow.getAllWindows();
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });
  app.whenReady().then(createWindow);
  app.on("window-all-closed", () => app.quit());
  app.on("before-quit", () => server?.kill());
}
