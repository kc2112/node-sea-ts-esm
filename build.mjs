import * as esbuild from 'esbuild';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

// Clean dist before building (best-effort on Windows)
const distDir = 'dist';
if (fs.existsSync(distDir)) {
  console.log('Cleaning dist/ ...');
  try {
    fs.rmSync(distDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  } catch (err) {
    console.warn(`Warning: could not fully remove dist/ (${err.code || err.message}). Continuing...`);
    // Try to clear contents instead
    try {
      for (const entry of fs.readdirSync(distDir)) {
        const p = path.join(distDir, entry);
        try { fs.rmSync(p, { recursive: true, force: true }); } catch {}
      }
    } catch {}
  }
}
fs.mkdirSync(distDir, { recursive: true });

const targetArg = (process.argv[2] || '').toLowerCase();
const target = targetArg === 'linux' || targetArg === 'windows' ? targetArg : process.platform === 'win32' ? 'windows' : 'linux';

const isWinTarget = target === 'windows';
const binName = isWinTarget ? 'myapp.exe' : 'myapp';
const outputName = path.join('dist', binName);
const outfile = 'dist/bundle.cjs';

// Where to look for a pre-downloaded Node binary for the target platform
const nodeBinaryDir = path.join('node-binaries', target);
const expectedNodeBin = isWinTarget
  ? path.join(nodeBinaryDir, 'node.exe')
  : path.join(nodeBinaryDir, 'node');

// Linux: extract node-v24.13.1-linux-x64.tar.gz if present, use it, clean up after
const linuxArchive = path.join('node-binaries', 'node-v24.13.1-linux-x64.tar.gz');
const linuxExtractDir = 'node-v24.13.1-linux-x64';
let extractedLinux = false;

if (target === 'linux' && fs.existsSync(linuxArchive)) {
  console.log(`Extracting ${linuxArchive} ...`);
  // Clean any previous extract
  if (fs.existsSync(linuxExtractDir)) {
    fs.rmSync(linuxExtractDir, { recursive: true, force: true });
  }
  execSync(`tar -xzf ${linuxArchive}`, { stdio: 'inherit' });
  extractedLinux = true;

  // Copy the node binary into node-binaries/linux
  fs.mkdirSync(nodeBinaryDir, { recursive: true });
  const srcNode = path.join(linuxExtractDir, 'bin', 'node');
  if (!fs.existsSync(srcNode)) {
    throw new Error(`Expected node binary not found after extract: ${srcNode}`);
  }
  fs.copyFileSync(srcNode, expectedNodeBin);
  if (process.platform !== 'win32') {
    fs.chmodSync(expectedNodeBin, 0o755);
  }
  console.log(`Copied node → ${expectedNodeBin}`);
}

console.log(`Target: ${target}`);
console.log(`Output: ${outputName}`);

// Ensure dist exists
fs.mkdirSync('dist', { recursive: true });

await esbuild.build({
  entryPoints: ['src/index.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile,
  minify: true,
  sourcemap: false,
  target: 'es2022',
  external: [],
});

console.log(`Bundled → ${outfile}`);

// Detect whether --build-sea is available (Node >= 25.5.0)
const major = Number(process.versions.node.split('.')[0]);
const minor = Number(process.versions.node.split('.')[1]);
const supportsBuildSea = major > 25 || (major === 25 && minor >= 5);

console.log(`Node ${process.versions.node} | build-sea: ${supportsBuildSea}`);

// Base config
const baseConfig = JSON.parse(fs.readFileSync('sea-config.json', 'utf8'));
baseConfig.main = outfile;
baseConfig.mainFormat = 'commonjs';
baseConfig.output = outputName;

// Cross-compile: point at a target Node binary if one was provided
let executablePath = null;
if (fs.existsSync(expectedNodeBin)) {
  executablePath = path.resolve(expectedNodeBin);
  console.log(`Using target Node binary: ${executablePath}`);
  baseConfig.executable = executablePath;
  // Required for cross-platform SEA
  baseConfig.useCodeCache = false;
  baseConfig.useSnapshot = false;
} else if (targetArg) {
  console.warn(
    `Warning: no target Node binary found at ${expectedNodeBin}. ` +
    `Building with the current Node (${process.platform}). ` +
    `Place the ${target} Node binary there for a true cross-compile.`
  );
}

// Drop any assets whose source files do not exist yet
if (baseConfig.assets && typeof baseConfig.assets === 'object') {
  const assets = { ...baseConfig.assets };
  for (const [key, filePath] of Object.entries(assets)) {
    if (typeof filePath === 'string' && !fs.existsSync(filePath)) {
      console.warn(`Warning: SEA asset missing, skipping: ${filePath}`);
      delete assets[key];
    }
  }
  baseConfig.assets = assets;
}

const runtimeConfigPath = path.join(distDir, 'sea-config.runtime.json');
fs.writeFileSync(runtimeConfigPath, JSON.stringify(baseConfig, null, 2));

try {
  if (supportsBuildSea) {
    console.log('Building SEA with --build-sea...');
    execSync(`node --build-sea ${runtimeConfigPath}`, { stdio: 'inherit' });
  } else {
    console.log('Building SEA with legacy postject flow (Node < 25.5)...');

    const legacyConfig = {
      ...baseConfig,
      output: path.join(distDir, 'sea-prep.blob'),
      useCodeCache: false,
      useSnapshot: false,
    };
    const legacyPath = path.join(distDir, 'sea-config.legacy.json');
    fs.writeFileSync(legacyPath, JSON.stringify(legacyConfig, null, 2));

    try {
      // 1. Generate the blob
      execSync(`node --experimental-sea-config ${legacyPath}`, { stdio: 'inherit' });

      // 2. Copy the appropriate Node binary into dist/
      const sourceBin = executablePath || process.execPath;
      fs.copyFileSync(sourceBin, outputName);
      if (!isWinTarget) {
        fs.chmodSync(outputName, 0o755);
      }

      // 3. Inject with postject
      const blob = path.join(distDir, 'sea-prep.blob');
      if (!fs.existsSync(blob)) {
        throw new Error(`Expected blob file not found: ${blob}`);
      }

      execSync(
        `npx --yes postject ${outputName} NODE_SEA_BLOB ${blob} --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2`,
        { stdio: 'inherit' }
      );
    } finally {
      try { fs.unlinkSync(legacyPath); } catch {}
    }
  }
} finally {
  try { fs.unlinkSync(runtimeConfigPath); } catch {}
  // Always remove the extracted Linux Node folder
  if (extractedLinux && fs.existsSync(linuxExtractDir)) {
    console.log(`Removing ${linuxExtractDir} ...`);
    try {
      fs.rmSync(linuxExtractDir, { recursive: true, force: true });
    } catch (err) {
      console.warn(`Warning: could not remove ${linuxExtractDir}: ${err.message}`);
    }
  }
}

if (process.platform === 'darwin' && !isWinTarget) {
  console.log('Signing macOS binary...');
  execSync(`codesign --sign - ${outputName}`, { stdio: 'inherit' });
}

console.log(`Done → ${outputName}`);
