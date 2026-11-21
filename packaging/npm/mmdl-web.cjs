#!/usr/bin/env node
// OpenAI-Codex: launch the packaged web app with a user-writable download directory.
'use strict';
const { spawn } = require('node:child_process');
const path = require('node:path');
const args = process.argv.slice(2);
if (args.length === 1 && args[0] === '--version') {
  console.log(require('../package.json').version);
} else if (args.length === 1 && args[0] === '--help') {
  console.log('Run multimedia-downloader-web to start the local web app. Configure HOST, PORT, MMDL_DOWNLOADS, and MMDL_PYTHON through environment variables.');
} else if (args.length) {
  console.error('Unrecognized arguments. Use --help for usage.');
  process.exitCode = 2;
} else {
  const python = process.env.MMDL_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
  const app = path.join(__dirname, '..', 'app', 'web_app.py');
  const child = spawn(python, ['-u', app], {
    stdio: 'inherit',
    env: { ...process.env,
      MMDL_DOWNLOADS: process.env.MMDL_DOWNLOADS || path.resolve(process.cwd(), 'downloads'),
      PYTHONDONTWRITEBYTECODE: '1' },
  });
  child.on('error', (error) => {
    console.error('Could not start Python:', error.message);
    process.exitCode = 1;
  });
  child.on('exit', (code, signal) => {
    if (signal) process.exitCode = 1;
    else process.exitCode = Number.isInteger(code) ? code : 1;
  });
}
