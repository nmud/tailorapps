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

// Generated code may only use files inside its own folder and the shared packages. Without this,
// a ?raw or ?url import (or a CSS url()) could copy any file on the computer into the app.
const WORKSPACE_MODULES = path.resolve(appDir, '../../node_modules');
const ALLOWED_ROOTS = [appDir, WORKSPACE_MODULES].map((p) => p.toLowerCase() + path.sep);

function allowedFile(id) {
  const file = String(id).split('?')[0];
  if (!file || file.startsWith('\0')) return true; // virtual modules
  // Bundle entries name their source relative to the app folder.
  const full = path.resolve(appDir, file).toLowerCase();
  return ALLOWED_ROOTS.some((root) => full.startsWith(root));
}

function confine() {
  const refuse = (what) => {
    throw new Error(`This app tried to use a file outside its own folder (${what}). Only use files inside src/.`);
  };
  return {
    name: 'tailor-confine',
    enforce: 'pre',
    async resolveId(source, importer, options) {
      const resolved = await this.resolve(source, importer, { ...options, skipSelf: true });
      if (resolved && !resolved.external && !allowedFile(resolved.id)) refuse(source);
      return resolved;
    },
    load(id) {
      if (!allowedFile(id)) refuse(path.basename(id.split('?')[0]));
      return null;
    },
    generateBundle(_, bundle) {
      for (const item of Object.values(bundle)) {
        const sources = item.type === 'chunk' ? [...(item.moduleIds ?? Object.keys(item.modules ?? {}))] : [...(item.originalFileNames ?? [])];
        for (const id of sources) if (!allowedFile(id)) refuse(path.basename(String(id).split('?')[0]));
      }
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
    plugins: [confine(), react(), tailorHtml(manifest)],
    resolve: { dedupe: ['react', 'react-dom'], preserveSymlinks: true },
    publicDir: path.join(appDir, 'public'),
    build: {
      outDir: 'dist',
      emptyOutDir: true,
      sourcemap: false,
      // Every asset becomes a separate file, so the check above sees all of them.
      assetsInlineLimit: 0,
      chunkSizeWarningLimit: 5000,
      reportCompressedSize: false,
    },
  });
  console.log(JSON.stringify({ ok: true }));
} catch (err) {
  console.log(JSON.stringify({ ok: false, errors: [describe(err)] }));
}
