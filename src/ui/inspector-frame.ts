/** Stateless geometry and chrome for local inspector overlays. */
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

export const INSPECTOR_FRAME_EVENT = "pi-persona:inspector-frame:v1";

export interface InspectorFrameLayout {
	width: number;
	height: number;
	contentWidth: number;
	contentRows: number;
	gutter: number;
	framed: boolean;
}

export interface InspectorFrame {
	viewportRows(terminalRows: number): number;
	layout(width: number, height: number): InspectorFrameLayout;
	render(lines: readonly string[], layout: InspectorFrameLayout, border: (text: string) => string): string[];
}

export interface InspectorFrameProviderResponse {
	version: 1;
	provider: "pi-persona";
	frame: InspectorFrame;
}

export interface InspectorFrameQuery {
	version: 1;
	respond: (response: InspectorFrameProviderResponse) => void;
}

function dimension(value: number): number {
	return Number.isFinite(value) ? Math.max(1, Math.floor(value)) : 1;
}

export const inspectorFrame: InspectorFrame = {
	viewportRows(terminalRows) {
		const rows = dimension(terminalRows);
		return Math.max(1, Math.min(Math.floor(rows * 0.9), rows - 2));
	},
	layout(width, height) {
		width = dimension(width);
		height = dimension(height);
		const framed = width >= 5 && height >= 3;
		const gutter = framed ? (width >= 7 ? 2 : 1) : 0;
		return { width, height, framed, gutter, contentWidth: width - (framed ? 2 + gutter * 2 : 0), contentRows: height - (framed ? 2 : 0) };
	},
	render(lines, layout, border) {
		const body = lines.slice(0, layout.contentRows).map((line) => {
			const text = truncateToWidth(line, layout.contentWidth, "…");
			if (!layout.framed) return text;
			const gutter = " ".repeat(layout.gutter);
			return `${border("│")}${gutter}${text}${" ".repeat(Math.max(0, layout.contentWidth - visibleWidth(text)))}${gutter}${border("│")}`;
		});
		if (!layout.framed) return body;
		return [border(`┌${"─".repeat(layout.width - 2)}┐`), ...body, border(`└${"─".repeat(layout.width - 2)}┘`)];
	},
};
