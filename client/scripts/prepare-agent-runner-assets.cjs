const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const MANIFEST_PATH = path.join(__dirname, 'agent-runner-assets.json');
const OUTPUT_ROOT = process.env.AGENT_RUNNER_ASSET_DIR || '/opt/agent-assets';

function readArg(name, fallback = '') {
  const index = process.argv.indexOf(name);
  if (index >= 0 && process.argv[index + 1]) return process.argv[index + 1];
  const inline = process.argv.find((item) => item.startsWith(`${name}=`));
  return inline ? inline.slice(name.length + 1) : fallback;
}

function downloadFile(url, targetPath) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    const request = (currentUrl, redirects = 0) => {
      if (redirects > 5) {
        reject(new Error('Runner asset 重定向次数超限'));
        return;
      }
      https.get(currentUrl, { headers: { 'user-agent': 'bidmaster-agent-runner-builder' } }, (response) => {
        if ([301, 302, 303, 307, 308].includes(response.statusCode) && response.headers.location) {
          response.resume();
          request(new URL(response.headers.location, currentUrl).toString(), redirects + 1);
          return;
        }
        if (response.statusCode < 200 || response.statusCode >= 300) {
          response.resume();
          reject(new Error(`Runner asset 下载失败：HTTP ${response.statusCode}`));
          return;
        }
        const file = fs.createWriteStream(targetPath, { mode: 0o600 });
        response.pipe(file);
        file.once('finish', () => file.close(resolve));
        file.once('error', reject);
      }).on('error', reject);
    };
    request(url);
  });
}

function verifyChecksum(filePath, expected, label) {
  const actual = crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
  if (actual !== expected) throw new Error(`${label} checksum 校验失败`);
  return actual;
}

function walkFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const filePath = path.join(directory, entry.name);
    return entry.isDirectory() ? walkFiles(filePath) : [filePath];
  });
}

function findBinary(directory, binaryName) {
  const expected = binaryName.toLowerCase();
  const filePath = walkFiles(directory).find((candidate) => path.basename(candidate).toLowerCase() === expected);
  if (!filePath) throw new Error(`Runner asset 缺少 ${binaryName} binary`);
  return filePath;
}

function verifyExecutable(filePath, command, args = ['--version']) {
  fs.accessSync(filePath, fs.constants.X_OK);
  try {
    execFileSync(filePath, args, { stdio: 'pipe', timeout: 20_000 });
  } catch (error) {
    throw new Error(`${command} binary 自检失败`);
  }
}

async function prepareAsset(command, descriptor, tmpRoot, binRoot) {
  const archivePath = path.join(tmpRoot, descriptor.fileName);
  await downloadFile(descriptor.url, archivePath);
  verifyChecksum(archivePath, descriptor.sha256, command);
  let binaryPath = archivePath;
  if (descriptor.archive === 'tar.gz') {
    const extractRoot = path.join(tmpRoot, `${command}-extract`);
    fs.mkdirSync(extractRoot, { recursive: true });
    execFileSync('tar', ['-xzf', archivePath, '-C', extractRoot], { stdio: 'pipe' });
    binaryPath = findBinary(extractRoot, descriptor.binary);
  }
  const targetPath = path.join(binRoot, descriptor.binary);
  fs.copyFileSync(binaryPath, targetPath);
  fs.chmodSync(targetPath, 0o755);
  verifyExecutable(targetPath, command, command === 'jq' ? ['-n', '1+1'] : ['--version']);
  return { command, fileName: descriptor.fileName, sha256: descriptor.sha256 };
}

async function main() {
  const architecture = readArg('--arch', process.arch);
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
  const version = String(process.env.OPENCODE_VERSION || manifest.opencodeVersion).trim();
  if (version !== manifest.opencodeVersion) throw new Error('Runner OpenCode version 未被固定清单允许');
  const descriptors = manifest.architectures?.[architecture];
  if (!descriptors) throw new Error(`Runner 不支持 Docker architecture：${architecture}`);

  const tmpRoot = path.join(ROOT, '.tmp-agent-runner-assets', architecture);
  const binRoot = path.join(OUTPUT_ROOT, 'bin');
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  fs.rmSync(OUTPUT_ROOT, { recursive: true, force: true });
  fs.mkdirSync(binRoot, { recursive: true });
  const assets = [];
  for (const command of ['opencode', 'rg', 'fd', 'jq']) {
    assets.push(await prepareAsset(command, descriptors[command], tmpRoot, binRoot));
  }
  execFileSync('prlimit', ['--version'], { stdio: 'pipe', timeout: 5000 });
  fs.writeFileSync(path.join(OUTPUT_ROOT, 'manifest.json'), JSON.stringify({
    opencodeVersion: version,
    architecture,
    assets,
    prlimit: 'system-util-linux',
  }, null, 2));
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  console.log(`Prepared Agent Runner assets: ${architecture}`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error?.message || String(error));
    process.exit(1);
  });
}

module.exports = { verifyChecksum };
