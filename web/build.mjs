// Offline production bundler for the web frontend.
//
// Bundles src/main.js (and its ~150-module graph) into a small set of hashed,
// cacheable files under web/dist, then writes dist/index.html pointing at the
// hashed entry bundle. esbuild is resolved from the vendored node_modules, so
// this never touches the network (matches the GitHub-free / vendor-only build
// stance — see docs/DEPENDENCIES.md).
//
// Run from the web/ directory: `node build.mjs` (or `npm run build`).

import { rm, mkdir, readFile, writeFile } from 'node:fs/promises';
import { brotliCompress, constants as zlibConstants, gzip } from 'node:zlib';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import * as esbuild from 'esbuild';

const webDir = dirname(fileURLToPath(import.meta.url));
const distDir = join(webDir, 'dist');
const brotliCompressAsync = promisify(brotliCompress);
const gzipAsync = promisify(gzip);

async function writeCompressedVariants(path) {
  const source = await readFile(path);
  const [brotli, gzipped] = await Promise.all([
    brotliCompressAsync(source, {
      params: {
        // Quality 11 makes release builds needlessly slow for almost no gain;
        // 9 is deterministic and compresses the chart bundle within ~1%.
        [zlibConstants.BROTLI_PARAM_QUALITY]: 9,
      },
    }),
    gzipAsync(source, { level: 9 }),
  ]);
  await Promise.all([
    writeFile(`${path}.br`, brotli),
    writeFile(`${path}.gz`, gzipped),
  ]);
}

// Lightweight Charts 5.2.1 has an upstream assertion in its internal barStyleFnMap (Pt)
// that calls ensureNotNull(findBar(barIndex, precomputedBars)). When bars are conflated
// during rapid zoom/pan or when overlay series have differing lengths/whitespace, findBar
// returns null, causing LC to throw an unhandled "Value is null" exception during render.
// This plugin patches barStyleFnMap to fall back to the series default styling when
// the bar at barIndex is null, and neutralizes the throwing ensureNotNull assertion.
const lightweightChartsNullSafetyPlugin = {
  name: 'lightweight-charts-null-safety',
  setup(build) {
    build.onLoad({ filter: /lightweight-charts\.(production|development)\.mjs$/ }, async (args) => {
      let source = await readFile(args.path, 'utf8');
      const prodTarget = 'const Pt={Bar:(t,i,n,s)=>{const e=i.upColor,r=i.downColor,h=u(t(n,s)),a=c(h.Wt[0])<=c(h.Wt[3]);return{sh:h.R??(a?e:r)}},Candlestick:(t,i,n,s)=>{const e=i.upColor,r=i.downColor,h=i.borderUpColor,a=i.borderDownColor,l=i.wickUpColor,o=i.wickDownColor,_=u(t(n,s)),d=c(_.Wt[0])<=c(_.Wt[3]);return{sh:_.R??(d?e:r),eh:_.Ht??(d?h:a),rh:_.hh??(d?l:o)}},Custom:(t,i,n,s)=>({sh:u(t(n,s)).R??i.color}),Area:(t,i,n,s)=>{const e=u(t(n,s));return{sh:e.vt??i.lineColor,vt:e.vt??i.lineColor,ah:e.ah??i.topColor,oh:e.oh??i.bottomColor}},Baseline:(t,i,n,s)=>{const e=u(t(n,s));return{sh:e.Wt[3]>=i.baseValue.price?i.topLineColor:i.bottomLineColor,_h:e._h??i.topLineColor,uh:e.uh??i.bottomLineColor,dh:e.dh??i.topFillColor1,fh:e.fh??i.topFillColor2,ph:e.ph??i.bottomFillColor1,mh:e.mh??i.bottomFillColor2}},Line:(t,i,n,s)=>{const e=u(t(n,s));return{sh:e.R??i.color,vt:e.R??i.color}},Histogram:(t,i,n,s)=>({sh:u(t(n,s)).R??i.color})};';
      const prodReplacement = 'const Pt={Bar:(t,i,n,s)=>{const e=i.upColor,r=i.downColor,h=t(n,s);if(!h)return{sh:e};const a=c(h.Wt[0])<=c(h.Wt[3]);return{sh:h.R??(a?e:r)}},Candlestick:(t,i,n,s)=>{const e=i.upColor,r=i.downColor,h=i.borderUpColor,a=i.borderDownColor,l=i.wickUpColor,o=i.wickDownColor,_=t(n,s);if(!_)return{sh:e,eh:h,rh:l};const d=c(_.Wt[0])<=c(_.Wt[3]);return{sh:_.R??(d?e:r),eh:_.Ht??(d?h:a),rh:_.hh??(d?l:o)}},Custom:(t,i,n,s)=>{const e=t(n,s);return{sh:e?.R??i.color}},Area:(t,i,n,s)=>{const e=t(n,s);return{sh:e?.vt??i.lineColor,vt:e?.vt??i.lineColor,ah:e?.ah??i.topColor,oh:e?.oh??i.bottomColor}},Baseline:(t,i,n,s)=>{const e=t(n,s);return e?{sh:e.Wt[3]>=i.baseValue.price?i.topLineColor:i.bottomLineColor,_h:e._h??i.topLineColor,uh:e.uh??i.bottomLineColor,dh:e.dh??i.topFillColor1,fh:e.fh??i.topFillColor2,ph:e.ph??i.bottomFillColor1,mh:e.mh??i.bottomFillColor2}:{sh:i.topLineColor,_h:i.topLineColor,uh:i.bottomLineColor,dh:i.topFillColor1,fh:i.topFillColor2,ph:i.bottomFillColor1,mh:i.bottomFillColor2}},Line:(t,i,n,s)=>{const e=t(n,s);return{sh:e?.R??i.color,vt:e?.R??i.color}},Histogram:(t,i,n,s)=>{const e=t(n,s);return{sh:e?.R??i.color}}};';
      if (source.includes(prodTarget)) {
        source = source.replace(prodTarget, prodReplacement);
      }
      const uTarget = 'function u(t){if(null===t)throw new Error("Value is null");return t}';
      const uReplacement = 'function u(t){return t}';
      if (source.includes(uTarget)) {
        source = source.replace(uTarget, uReplacement);
      }
      return { contents: source, loader: 'js' };
    });
  },
};

async function main() {
  // Start clean so stale hashed files never accumulate.
  await rm(distDir, { recursive: true, force: true });
  await mkdir(distDir, { recursive: true });

  const result = await esbuild.build({
    absWorkingDir: webDir,
    entryPoints: ['src/main.js'],
    bundle: true,
    format: 'esm',
    splitting: true,
    minify: true,
    // Production does not ship source maps — they ~double dist size and are
    // unused by the desktop single-user shell. Enable locally only if debugging.
    sourcemap: false,
    // Keep the bundle on a modern, broadly supported ESM baseline.
    target: ['es2022'],
    outdir: 'dist',
    entryNames: '[name]-[hash]',
    chunkNames: 'chunks/[name]-[hash]',
    metafile: true,
    logLevel: 'info',
    plugins: [lightweightChartsNullSafetyPlugin],
    // lightweight-charts is a normal ESM dependency and is bundled into the
    // production graph. This makes a successful build prove that the exact
    // pinned chart version is deployable; runtime no longer depends on a
    // separately served node_modules path.
  });

  const cssResult = await esbuild.build({
    absWorkingDir: webDir,
    entryPoints: ['styles.css'],
    bundle: true,
    minify: true,
    target: ['es2022'],
    outdir: 'dist',
    entryNames: 'styles-[hash]',
    metafile: true,
    logLevel: 'info',
    external: ['/assets/*'],
  });

  // Find the hashed output produced for the src/main.js entry.
  const entryOutput = Object.entries(result.metafile.outputs).find(
    ([, meta]) => meta.entryPoint === 'src/main.js',
  );
  if (!entryOutput) {
    throw new Error('build: could not locate src/main.js entry in metafile outputs');
  }
  // metafile keys are relative to web/ (e.g. "dist/main-ABCD1234.js"); the
  // server serves them at an absolute URL of the same path.
  const bundleUrl = '/' + entryOutput[0].split('\\').join('/');
  const cssOutput = Object.entries(cssResult.metafile.outputs).find(
    ([, meta]) => meta.entryPoint === 'styles.css',
  );
  if (!cssOutput) {
    throw new Error('build: could not locate styles.css output in metafile');
  }
  const cssUrl = '/' + cssOutput[0].split('\\').join('/');

  // Rewrite index.html's module script tag to point at the hashed bundle.
  // The classic /config.js script is left untouched so it still runs before
  // the deferred module bundle evaluates.
  const templatePath = join(webDir, 'index.html');
  const template = await readFile(templatePath, 'utf8');
  const moduleScriptRe = /<script\s+type="module"\s+src="\/src\/main\.js"\s*>\s*<\/script>/;
  if (!moduleScriptRe.test(template)) {
    throw new Error('build: could not find <script type="module" src="/src/main.js"> in index.html');
  }
  const shell = template.replace(
    moduleScriptRe,
    `<script type="module" src="${bundleUrl}"></script>`,
  ).replace(
    '<link rel="stylesheet" href="/styles.css">',
    `<link rel="stylesheet" href="${cssUrl}">`,
  );
  const indexOutput = join(distDir, 'index.html');
  await writeFile(indexOutput, shell, 'utf8');

  const compressibleOutputs = [
    ...Object.keys(result.metafile.outputs),
    ...Object.keys(cssResult.metafile.outputs),
  ]
    .filter((output) => /\.(?:js|css)$/.test(output))
    .map((output) => join(webDir, output));
  await Promise.all([...compressibleOutputs, indexOutput].map(writeCompressedVariants));

  console.log(`build: entry bundle ${bundleUrl}`);
  console.log(`build: stylesheet ${cssUrl}`);
  console.log(`build: wrote dist/index.html`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
