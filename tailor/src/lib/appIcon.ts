import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { api } from './api';
import { APP_ICONS } from './icons';
import type { AppRecord } from './types';

// Solid colours for each accent (icons are drawn on canvas, outside the page's CSS).
const PALETTE: Record<string, { from: string; to: string; ink: string }> = {
  moss: { from: 'oklch(62% 0.12 150)', to: 'oklch(42% 0.1 160)', ink: 'oklch(98% 0.01 150)' },
  ink: { from: 'oklch(52% 0.09 260)', to: 'oklch(32% 0.07 265)', ink: 'oklch(98% 0.01 260)' },
  clay: { from: 'oklch(66% 0.14 45)', to: 'oklch(50% 0.14 35)', ink: 'oklch(99% 0.01 40)' },
  tide: { from: 'oklch(64% 0.1 220)', to: 'oklch(45% 0.09 230)', ink: 'oklch(99% 0.01 220)' },
  plum: { from: 'oklch(58% 0.13 340)', to: 'oklch(40% 0.11 335)', ink: 'oklch(99% 0.01 340)' },
  ochre: { from: 'oklch(78% 0.13 80)', to: 'oklch(60% 0.13 70)', ink: 'oklch(25% 0.04 70)' },
};

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

/** Draw the app's glyph as a 256px glassy tile and save it as the app's Windows icon. */
export async function makeAppIcon(app: Pick<AppRecord, 'id' | 'icon' | 'accent'>): Promise<void> {
  const colors = PALETTE[app.accent] ?? PALETTE.moss;
  const Icon = APP_ICONS[app.icon] ?? APP_ICONS.layers;
  const svg = renderToStaticMarkup(createElement(Icon, { size: 128, color: colors.ink, strokeWidth: 1.75 }));
  const glyph = await loadImage(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`);

  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const r = 60;
  const tile = new Path2D();
  tile.roundRect(8, 8, size - 16, size - 16, r);
  const fill = ctx.createLinearGradient(0, 0, 0, size);
  fill.addColorStop(0, colors.from);
  fill.addColorStop(1, colors.to);
  ctx.fillStyle = fill;
  ctx.fill(tile);
  // glass sheen on the top half
  ctx.save();
  ctx.clip(tile);
  const sheen = ctx.createLinearGradient(0, 0, 0, size * 0.55);
  sheen.addColorStop(0, 'rgba(255,255,255,0.38)');
  sheen.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = sheen;
  ctx.fillRect(0, 0, size, size * 0.55);
  ctx.restore();
  ctx.strokeStyle = 'rgba(255,255,255,0.35)';
  ctx.lineWidth = 3;
  ctx.stroke(tile);
  ctx.drawImage(glyph, (size - 128) / 2, (size - 128) / 2, 128, 128);

  const blob = await new Promise<Blob>((resolve) => canvas.toBlob((b) => resolve(b!), 'image/png'));
  const png = Array.from(new Uint8Array(await blob.arrayBuffer()));
  await api.appSetIcon(app.id, png);
}
