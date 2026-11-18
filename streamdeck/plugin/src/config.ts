import fs from "node:fs";
import path from "node:path";

/** Scène telle qu'enregistrée par Screen Switcher (seuls les champs utiles au plugin). */
export type Scene = { id: string; name: string; shortcut?: string; icon?: string; color?: string };
export type AppConfig = { scenes: Scene[]; lastSceneId: string | null };

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
		return { scenes, lastSceneId: raw.lastSceneId ?? null };
	} catch {
		return null;
	}
}

let timer: NodeJS.Timeout | undefined;
let retries = 0;
function reload(): void {
	clearTimeout(timer);
	// L'app réécrit le fichier d'un bloc : on laisse passer la rafale d'événements,
	// et on réessaie si le JSON est lu à moitié écrit.
	timer = setTimeout(() => {
		const next = read();
		if (!next && fs.existsSync(FILE) && retries++ < 10) return reload();
		retries = 0;
		if (JSON.stringify(next) === JSON.stringify(current)) return;
		current = next;
		for (const l of listeners) l(current);
	}, 150);
}

/** Configuration courante de Screen Switcher (null si l'app n'a jamais été lancée). */
export function getConfig(): AppConfig | null {
	return current;
}

export function onConfigChange(listener: (cfg: AppConfig | null) => void): void {
	listeners.add(listener);
}

/** Lit la config et surveille son dossier (le fichier peut ne pas encore exister). */
export function watchConfig(): void {
	current = read();
	const start = (): void => {
		try {
			fs.watch(DIR, (_ev, name) => {
				if (!name || name.toString().toLowerCase() === "config.json") reload();
			});
			reload();
		} catch {
			setTimeout(start, 5000); // dossier absent : l'app n'a pas encore été lancée
		}
	};
	start();
}
