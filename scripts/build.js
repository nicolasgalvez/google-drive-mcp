#!/usr/bin/env node

import * as esbuild from 'esbuild';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const isWatch = process.argv.includes('--watch');

/** @type {import('esbuild').BuildOptions} */
const sharedOptions = {
  bundle: true,
  platform: 'node',
  target: 'node18',
  format: 'esm',
  packages: 'external', // Don't bundle node_modules
  sourcemap: true,
};

/** @type {import('esbuild').BuildOptions} */
const buildOptions = {
  ...sharedOptions,
  entryPoints: [join(__dirname, '../src/index.ts')],
  outfile: join(__dirname, '../dist/index.js'),
  external: ['./setup.js'], // setup is a separate entry point
};

/** @type {import('esbuild').BuildOptions} */
const setupOptions = {
  ...sharedOptions,
  entryPoints: [join(__dirname, '../src/setup.ts')],
  outfile: join(__dirname, '../dist/setup.js'),
};

if (isWatch) {
  const [ctx1, ctx2] = await Promise.all([
    esbuild.context(buildOptions),
    esbuild.context(setupOptions),
  ]);
  await Promise.all([ctx1.watch(), ctx2.watch()]);
  console.log('Watching for changes...');
} else {
  await Promise.all([
    esbuild.build(buildOptions),
    esbuild.build(setupOptions),
  ]);

  // Make the files executable on non-Windows platforms
  if (process.platform !== 'win32') {
    const { chmod } = await import('fs/promises');
    await chmod(buildOptions.outfile, 0o755);
  }
  console.log('Build complete!');
}