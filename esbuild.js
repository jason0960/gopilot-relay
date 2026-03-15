const esbuild = require('esbuild');
const path = require('path');

const rootDir = __dirname;

esbuild.build({
  entryPoints: [path.join(rootDir, 'src/index.ts')],
  bundle: true,
  platform: 'node',
  target: 'node18',
  outfile: path.join(rootDir, 'dist/index.js'),
  format: 'cjs',
  sourcemap: true,
  external: [],
  minify: process.argv.includes('--production'),
}).then(() => {
  console.log('[gopilot-relay] Build complete.');
}).catch((err) => {
  console.error(err);
  process.exit(1);
});
