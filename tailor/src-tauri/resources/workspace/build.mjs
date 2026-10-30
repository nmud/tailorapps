// Builds one generated app: `node build.mjs apps/<slug>`.
// Prints a single JSON line: {"ok": true} or {"ok": false, "errors": [...]}.
import fs from 'node:fs';
import path from 'node:path';
import { build } from 'vite';
import react from '@vitejs/plugin-react';

const appDir = path.resolve(process.argv[2] ?? '');
const ANSI = /\u001b\[[0-9;]*m/g;

function readManifest() {
  try {
    return JSON.parse(fs.readFileSync(path.join(appDir, 'tailor.json'), 'utf8'));
  } catch {
    return {};
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
}

function tailorHtml(manifest) {
  const accent = /^[a-z]+$/.test(manifest.accent ?? '') ? manifest.accent : 'moss';
  return {
    name: 'tailor-html',
    transformIndexHtml(html) {
      return html
        .replace('<html lang="en">', `<html lang="en" data-accent="${accent}">`)
        .replace('<title>App</title>', `<title>${escapeHtml(manifest.name ?? 'App')}</title>`);
    },
  };
}

function describe(err) {
  const lines = [];
  const loc = err.loc ? `${path.relative(appDir, err.loc.file ?? err.id ?? '')}:${err.loc.line}:${err.loc.column}` : err.id ? path.relative(appDir, err.id) : '';
  lines.push(`${loc ? loc + ' ' : ''}${err.message ?? String(err)}`.replace(ANSI, ''));
  if (err.frame) lines.push(String(err.frame).replace(ANSI, ''));
  if (Array.isArray(err.errors)) {
    for (const e of err.errors.slice(0, 8)) lines.push(String(e.message ?? e).replace(ANSI, ''));
  }
  return lines.join('\n').split(path.sep).join('/').slice(0, 4000);
}

const manifest = readManifest();
try {
  await build({
    root: appDir,
    base: './',
    configFile: false,
    logLevel: 'silent',
    plugins: [react(), tailorHtml(manifest)],
    resolve: { dedupe: ['react', 'react-dom'] },
    build: {
      outDir: 'dist',
      emptyOutDir: true,
      sourcemap: false,
      chunkSizeWarningLimit: 5000,
      reportCompressedSize: false,
    },
  });
  console.log(JSON.stringify({ ok: true }));
} catch (err) {
  console.log(JSON.stringify({ ok: false, errors: [describe(err)] }));
}
