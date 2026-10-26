import { getAsset } from "node:sea";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";

const CACHE_ROOT = path.join(os.homedir(), ".cache", "myapp", "chrome");

function isWindows(): boolean {
  return process.platform === "win32";
}

function assetKey(): string {
  return isWindows()
    ? "chrome-headless-shell-win64.zip"
    : "chrome-headless-shell-linux64.zip";
}

function expectedExeRelative(): string {
  return isWindows()
    ? path.join("chrome-headless-shell-win64", "chrome-headless-shell.exe")
    : path.join("chrome-headless-shell-linux64", "chrome-headless-shell");
}

function getCacheExePath(): string {
  return path.join(CACHE_ROOT, expectedExeRelative());
}

function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

function extractZip(zipPath: string, dest: string): void {
  ensureDir(dest);
  if (isWindows()) {
    // PowerShell Expand-Archive
    execFileSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-Command",
        `Expand-Archive -Path '${zipPath.replace(/'/g, "''")}' -DestinationPath '${dest.replace(/'/g, "''")}' -Force`,
      ],
      { stdio: "inherit" }
    );
  } else {
    // unzip is standard on RHEL/Ubuntu
    execFileSync("unzip", ["-o", "-q", zipPath, "-d", dest], { stdio: "inherit" });
  }
}

/**
 * Ensures chrome-headless-shell is extracted to the cache directory.
 * Sets process.env.CHROME_CACHE to the absolute path of the executable.
 * Safe to call on every startup — extraction is skipped if the binary already exists.
 */
export function initChrome(): string {
  const exePath = getCacheExePath();

  if (fs.existsSync(exePath)) {
    process.env.CHROME_CACHE = exePath;
    return exePath;
  }

  console.log("Extracting chrome-headless-shell to cache…");
  ensureDir(CACHE_ROOT);

  const key = assetKey();
  let zipBuffer: Buffer;
  try {
    zipBuffer = Buffer.from(getAsset(key));
  } catch (err) {
    throw new Error(
      `SEA asset '${key}' not found. Ensure it is declared in sea-config.json and the zip exists at build time.`
    );
  }

  const zipPath = path.join(CACHE_ROOT, "chrome-headless-shell.zip");
  fs.writeFileSync(zipPath, zipBuffer);

  try {
    extractZip(zipPath, CACHE_ROOT);
  } finally {
    try {
      fs.unlinkSync(zipPath);
    } catch {
      /* ignore */
    }
  }

  if (!fs.existsSync(exePath)) {
    throw new Error(`Extraction finished but executable not found at: ${exePath}`);
  }

  if (!isWindows()) {
    fs.chmodSync(exePath, 0o755);
  }

  process.env.CHROME_CACHE = exePath;
  console.log(`CHROME_CACHE = ${exePath}`);
  return exePath;
}
