/** Key images: same tiles as in the app (src/scene-icons.js of the main project). */
import { lookOf, tileSvg } from "../../../src/scene-icons.js";

export { lookOf };

/** Stream Deck expects a data: URL (raw SVG is ignored); base64 for non-ASCII characters. */
export function toDataUrl(svg: string): string {
	return `data:image/svg+xml;base64,${Buffer.from(svg, "utf8").toString("base64")}`;
}

export function keyImage(look: { glyph: string; color: string }, label: string, dim = false): string {
	return toDataUrl(tileSvg(look, { label, dim }));
}
