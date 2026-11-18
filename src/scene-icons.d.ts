// Types for the Stream Deck plugin (TypeScript); the app uses scene-icons.js directly.
export type Look = { glyph: string; color: string };
export const GLYPHS: Record<string, string>;
export const GLYPH_NAMES: Record<string, string>;
export const COLORS: Record<string, [string, string]>;
export const COLOR_NAMES: Record<string, string>;
export const DEFAULT_COLOR: Record<string, string>;
export function guessGlyph(name: string): string;
export function lookOf(
	scene: { name?: string; icon?: string; color?: string } | null | undefined,
	over?: { icon?: string; color?: string },
): Look;
export function tileSvg(look: Look, opts?: { label?: string; dim?: boolean; size?: number }): string;
