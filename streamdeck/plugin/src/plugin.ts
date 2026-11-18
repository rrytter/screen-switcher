import streamDeck from "@elgato/streamdeck";

import { SceneAction } from "./actions/scene";
import { watchConfig } from "./config";
import { detect, setLang } from "../../../src/i18n.js";

streamDeck.logger.setLevel("info");
// Stream Deck software language (French if fr, English otherwise)
setLang(detect(streamDeck.info?.application?.language));
watchConfig();
streamDeck.actions.registerAction(new SceneAction());
streamDeck.connect();
