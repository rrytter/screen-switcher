import streamDeck, {
	action,
	type DidReceiveSettingsEvent,
	type KeyAction,
	type KeyDownEvent,
	type SendToPluginEvent,
	SingletonAction,
	type WillAppearEvent,
} from "@elgato/streamdeck";
import type { JsonValue } from "@elgato/utils";
import { execFile } from "node:child_process";

import { getConfig, onConfigChange } from "../config";
import { keyImage, lookOf } from "../icons";

type Settings = {
	sceneId?: string;
	icon?: string; // "auto" (= réglage de la scène dans l'app) ou une clé de GLYPHS
	color?: string; // "auto" ou une clé de COLORS
	highlight?: boolean; // assombrir les scènes inactives
};

/** Délai max entre l'appui et l'enregistrement de la scène par l'app (activer le projecteur prend quelques s). */
const CONFIRM_TIMEOUT = 15_000;

/** Ouvre screenswitcher://scene/<id> : Windows le transmet à l'app (qu'elle tourne déjà ou non). */
function launch(sceneId: string): Promise<void> {
	const url = `screenswitcher://scene/${encodeURIComponent(sceneId)}`;
	return new Promise((resolve) => {
		execFile("rundll32.exe", ["url.dll,FileProtocolHandler", url], (err) => {
			if (!err) return resolve();
			streamDeck.logger.warn(`rundll32 a échoué (${err.message}), repli sur openUrl`);
			streamDeck.system.openUrl(url).finally(resolve);
		});
	});
}

@action({ UUID: "com.rrytter.screenswitcher.scene" })
export class SceneAction extends SingletonAction<Settings> {
	/** Touches en attente de confirmation : id de l'action → scène demandée. */
	#pending = new Map<string, { sceneId: string; timer: NodeJS.Timeout }>();

	constructor() {
		super();
		onConfigChange(() => {
			this.#confirmPending();
			void this.#refreshAll();
			void this.#pushScenes();
		});
	}

	override onWillAppear(ev: WillAppearEvent<Settings>): Promise<void> | void {
		if (ev.action.isKey()) return this.#render(ev.action, ev.payload.settings);
	}

	override onDidReceiveSettings(ev: DidReceiveSettingsEvent<Settings>): Promise<void> | void {
		if (ev.action.isKey()) return this.#render(ev.action, ev.payload.settings);
	}

	override async onKeyDown(ev: KeyDownEvent<Settings>): Promise<void> {
		const { sceneId } = ev.payload.settings;
		if (!sceneId || !getConfig()?.scenes.some((s) => s.id === sceneId)) return ev.action.showAlert();

		const id = ev.action.id;
		clearTimeout(this.#pending.get(id)?.timer);
		// L'app réécrit sa config après chaque scène appliquée : sans ce signal, alerte ⚠ sur la touche.
		const timer = setTimeout(() => {
			this.#pending.delete(id);
			void ev.action.showAlert();
		}, CONFIRM_TIMEOUT);
		this.#pending.set(id, { sceneId, timer });
		await launch(sceneId);
	}

	/** L'inspecteur (sdpi-select datasource="getScenes") demande la liste des scènes. */
	override onSendToPlugin(ev: SendToPluginEvent<JsonValue, Settings>): Promise<void> | void {
		const p = ev.payload as { event?: string } | null;
		if (p?.event === "getScenes") return this.#pushScenes();
	}

	#pushScenes(): Promise<void> {
		if (!streamDeck.ui.action) return Promise.resolve();
		const scenes = getConfig()?.scenes ?? [];
		return streamDeck.ui.sendToPropertyInspector({
			event: "getScenes",
			items: scenes.map((s) => ({
				label: s.shortcut ? `${s.name} (${s.shortcut.replace(/Control/g, "Ctrl")})` : s.name,
				value: s.id,
			})),
		});
	}

	/** Scène appliquée : on annule l'alerte, sans rien afficher (le résultat attendu se voit déjà). */
	#confirmPending(): void {
		const last = getConfig()?.lastSceneId;
		for (const [id, p] of this.#pending) {
			if (p.sceneId !== last) continue;
			clearTimeout(p.timer);
			this.#pending.delete(id);
		}
	}

	async #refreshAll(): Promise<void> {
		for (const a of this.actions) if (a.isKey()) await this.#render(a, await a.getSettings());
	}

	#render(a: KeyAction<Settings>, s: Settings): Promise<void> {
		const cfg = getConfig();
		const unknown = { glyph: "unknown", color: "slate" };
		if (!cfg) return a.setImage(keyImage(unknown, "App absente"));
		const scene = cfg.scenes.find((x) => x.id === s.sceneId);
		if (!scene) return a.setImage(keyImage(unknown, s.sceneId ? "Supprimée" : "Choisir…"));
		// « auto » sur la touche = icône/couleur choisies dans l'app (ou devinées d'après le nom)
		const dim = s.highlight !== false && cfg.lastSceneId !== scene.id;
		return a.setImage(keyImage(lookOf(scene, s), scene.name, dim));
	}
}
