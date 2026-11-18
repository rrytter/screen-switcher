import streamDeck from "@elgato/streamdeck";

import { SceneAction } from "./actions/scene";
import { watchConfig } from "./config";

streamDeck.logger.setLevel("info");
watchConfig();
streamDeck.actions.registerAction(new SceneAction());
streamDeck.connect();
