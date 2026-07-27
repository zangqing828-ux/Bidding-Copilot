#!/usr/bin/env node
const { spawn } = require('node:child_process');

const separator = process.argv.indexOf('--');
if (separator < 0 || !process.argv[separator + 1]) process.exit(2);
const child = spawn(process.argv[separator + 1], process.argv.slice(separator + 2), { stdio: 'inherit', env: process.env });
child.once('exit', (code, signal) => process.exit(code === null ? 1 : code || (signal ? 1 : 0)));
