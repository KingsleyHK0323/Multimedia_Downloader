// OpenAI-Codex: assemble only the files needed by the installable web package.
import { cp, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const [sourceArg, outputArg, version, sha] = process.argv.slice(2);
if (!sourceArg || !outputArg || !version || !/^[0-9a-f]{40}$/.test(sha || '')) {
  throw new Error('Expected source, new output directory, version and source SHA.');
}
const toolsDir = path.dirname(fileURLToPath(import.meta.url));
const source = await realpath(sourceArg);
const output = path.resolve(outputArg);
const relative = path.relative(source, output);
if (!relative || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative))) {
  throw new Error('Output must be outside the source checkout.');
}
const root = JSON.parse(await readFile(path.join(source, 'package.json'), 'utf8'));
if (!/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.test(root.version || '')) {
  throw new Error('Source version is invalid.');
}
const dev = version.startsWith(root.version + '-dev.') && /^[1-9][0-9]*$/.test(version.slice((root.version + '-dev.').length));
if (version !== root.version && !dev) throw new Error('Package version does not match the source version.');
const manifest = JSON.parse(await readFile(path.join(toolsDir, 'package.json'), 'utf8'));
if (manifest.name !== '@kingsleyhk0323/multimedia-downloader' || manifest.publishConfig?.registry !== 'https://npm.pkg.github.com' || manifest.scripts || manifest.dependencies || manifest.devDependencies) {
  throw new Error('Unexpected package identity or install scripts.');
}
manifest.version = version;
manifest['x-mmdl-source-commit'] = sha;
await mkdir(output);
await mkdir(path.join(output, 'bin'));
await mkdir(path.join(output, 'app'));
await writeFile(path.join(output, 'package.json'), JSON.stringify(manifest, null, 2) + '\n');
await cp(path.join(toolsDir, 'mmdl-web.cjs'), path.join(output, 'bin', 'mmdl-web.cjs'));
await cp(path.join(toolsDir, 'README.md'), path.join(output, 'README.md'));
for (const name of ['LICENSE', 'THIRD-PARTY-NOTICES.md']) {
  await cp(path.join(source, name), path.join(output, name));
}
await cp(path.join(source, 'third-party'), path.join(output, 'third-party'), { recursive: true });
for (const name of ['web_app.py', 'web_upload.py', 'engine_sidecar.py', 'requirements-web.txt']) {
  await cp(path.join(source, name), path.join(output, 'app', name));
}
for (const name of ['ai', 'engine', 'i18n', 'locales']) {
  await cp(path.join(source, name), path.join(output, 'app', name), {
    recursive: true,
    filter: (entry) => !entry.split(path.sep).includes('__pycache__') && !entry.endsWith('.pyc'),
  });
}
await mkdir(path.join(output, 'app', 'frontend'));
await cp(path.join(source, 'frontend', 'dist'), path.join(output, 'app', 'frontend', 'dist'), { recursive: true });
