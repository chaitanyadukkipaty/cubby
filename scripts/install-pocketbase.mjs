// Downloads the PocketBase binary for this OS/arch into ./bin.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const VERSION = process.env.PB_VERSION || '0.40.5';
const os = { darwin: 'darwin', linux: 'linux', win32: 'windows' }[process.platform];
const arch = { x64: 'amd64', arm64: 'arm64' }[process.arch];
if (!os || !arch) throw new Error(`Unsupported platform ${process.platform}/${process.arch}`);

const binDir = join(process.cwd(), 'bin');
const bin = join(binDir, os === 'windows' ? 'pocketbase.exe' : 'pocketbase');
if (existsSync(bin)) {
  console.log(`PocketBase already installed at ${bin}`);
  process.exit(0);
}

const url = `https://github.com/pocketbase/pocketbase/releases/download/v${VERSION}/pocketbase_${VERSION}_${os}_${arch}.zip`;
console.log(`Downloading ${url}`);
const res = await fetch(url);
if (!res.ok) throw new Error(`Download failed: ${res.status}`);
mkdirSync(binDir, { recursive: true });
const zip = join(binDir, 'pocketbase.zip');
writeFileSync(zip, Buffer.from(await res.arrayBuffer()));
execFileSync('unzip', ['-o', zip, '-d', binDir], { stdio: 'inherit' });
rmSync(zip);
console.log(`Installed PocketBase v${VERSION} at ${bin}`);
