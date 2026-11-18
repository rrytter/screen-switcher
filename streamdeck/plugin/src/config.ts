import fs from "node:fs";
import path from "node:path";

/** Scene as saved by Screen Switcher (only the fields the plugin needs). */
export type Scene = { id: string; name: string; shortcut?: string; icon?: string; color?: string };
export type AppConfig = { scenes: Scene[]; lastSceneId: string | null; language?: string };

const DIR = path.join(process.env.APPDATA ?? "", "screen-switcher");
const FILE = path.join(DIR, "config.json");

let current: AppConfig | null = null;
const listeners = new Set<(cfg: AppConfig | null) => void>();

function read(): AppConfig | null {
	try {
		const raw = JSON.parse(fs.readFileSync(FILE, "utf8"));
		const scenes: Scene[] = Array.isArray(raw.scenes)
			? raw.scenes.map((s: Scene) => ({ id: s.id, name: s.name, shortcut: s.shortcut, icon: s.icon, color: s.color }))
			: [];
		return { scenes, lastSceneId: raw.lastSceneId ?? null, language: raw.settings?.language };
	} catch {
		return null;
	}
}

let timer: NodeJS.Timeout | undefined;
let retries = 0;
function reload(): void {
	clearTimeout(timer);
	// The app rewrites the file in one go: let the burst of events pass,
	// and retry if the JSON is read half-written.
	timer = setTimeout(() => {
		const next = read();
		if (!next && fs.existsSync(FILE) && retries++ < 10) return reload();
		retries = 0;
		if (JSON.stringify(next) === JSON.stringify(current)) return;
		current = next;
		for (const l of listeners) l(current);
	}, 150);
}

/** Current Screen Switcher configuration (null if the app has never been launched). */
export function getConfig(): AppConfig | null {
	return current;
}

export function onConfigChange(listener: (cfg: AppConfig | null) => void): void {
	listeners.add(listener);
}

/** Reads the config and watches its folder (the file may not exist yet). */
export function watchConfig(): void {
	current = read();
	const start = (): void => {
		try {
			fs.watch(DIR, (_ev, name) => {
				if (!name || name.toString().toLowerCase() === "config.json") reload();
			});
			reload();
		} catch {
			setTimeout(start, 5000); // folder missing: the app has not been launched yet
		}
	};
	start();
}
