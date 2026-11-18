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
import { detect, setLang, t } from "../../../../src/i18n.js";

type Settings = {
	sceneId?: string;
	icon?: string; // "auto" (= scene setting in the app) or a GLYPHS key
	color?: string; // "auto" or a COLORS key
	highlight?: boolean; // dim inactive scenes
};

/** Max delay between the key press and the app saving the scene (enabling a projector takes a few s). */
const CONFIRM_TIMEOUT = 15_000;

/** Opens screenswitcher://scene/<id>: Windows hands it to the app (running or not). */
function launch(sceneId: string): Promise<void> {
	const url = `screenswitcher://scene/${encodeURIComponent(sceneId)}`;
	return new Promise((resolve) => {
		execFile("rundll32.exe", ["url.dll,FileProtocolHandler", url], (err) => {
			if (!err) return resolve();
			streamDeck.logger.warn(`rundll32 failed (${err.message}), falling back to openUrl`);
			streamDeck.system.openUrl(url).finally(resolve);
		});
	});
}

@action({ UUID: "com.rrytter.screenswitcher.scene" })
export class SceneAction extends SingletonAction<Settings> {
	/** Keys waiting for confirmation: action id → requested scene. */
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
		// The app rewrites its config after each applied scene: without that signal, ⚠ alert on the key.
		const timer = setTimeout(() => {
			this.#pending.delete(id);
			void ev.action.showAlert();
		}, CONFIRM_TIMEOUT);
		this.#pending.set(id, { sceneId, timer });
		await launch(sceneId);
	}

	/** The inspector (sdpi-select datasource="getScenes") asks for the scene list. */
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

	/** Scene applied: cancel the alert, show nothing (the expected result is already visible). */
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
		// language: the app setting if set, otherwise the Stream Deck software language
		setLang(cfg?.language && cfg.language !== "system" ? cfg.language : detect(streamDeck.info?.application?.language));
		const unknown = { glyph: "unknown", color: "slate" };
		if (!cfg) return a.setImage(keyImage(unknown, t("key.noApp")));
		const scene = cfg.scenes.find((x) => x.id === s.sceneId);
		if (!scene) return a.setImage(keyImage(unknown, s.sceneId ? t("key.deleted") : t("key.choose")));
		// "auto" on the key = icon/color chosen in the app (or guessed from the name)
		const dim = s.highlight !== false && cfg.lastSceneId !== scene.id;
		return a.setImage(keyImage(lookOf(scene, s), scene.name, dim));
	}
}
