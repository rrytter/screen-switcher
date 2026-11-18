// Types for the Stream Deck plugin (TypeScript); the app uses i18n.js directly.
export function t(key: string, params?: Record<string, string | number>): string;
export function setLang(lang: string): string;
export function detect(locale: string | undefined | null): "en" | "fr";
export function pick<T>(value: T | { en: T; fr?: T }): T;
export function getLang(): string;
export const STRINGS: Record<string, Record<string, string>>;
export const LANG_NAMES: Record<string, string>;
