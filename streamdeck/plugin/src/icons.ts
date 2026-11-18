/** Images des touches : mêmes tuiles que dans l'app (src/scene-icons.js du projet principal). */
import { lookOf, tileSvg } from "../../../src/scene-icons.js";

export { lookOf };

/** Stream Deck attend une URL data: (le SVG brut est ignoré) ; base64 pour les accents. */
export function toDataUrl(svg: string): string {
	return `data:image/svg+xml;base64,${Buffer.from(svg, "utf8").toString("base64")}`;
}

export function keyImage(look: { glyph: string; color: string }, label: string, dim = false): string {
	return toDataUrl(tileSvg(look, { label, dim }));
}
