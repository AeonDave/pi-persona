/** UI-only prose projection. Never rewrites stored/model-facing text or unwraps trust fences. */
import { getMarkdownTheme, type Theme, type ThemeBg } from "@earendil-works/pi-coding-agent";
import { Markdown, Text, truncateToWidth, type Component } from "@earendil-works/pi-tui";
import { sanitizeTerminalText } from "./presentation.ts";

interface ReportBodyOptions {
	/** Trusted chrome stays literal Text, outside the Markdown body. Evaluated at paint time. */
	header?: (width: number) => string;
	/** Custom session cards only. Normal tools already have the host's shell. */
	background?: ThemeBg;
	padding?: number;
}

class ReportBody implements Component {
	private readonly markdownTheme = getMarkdownTheme();
	private readonly markdown: Markdown;
	readonly source: string;
	private theme: Theme;
	private options: ReportBodyOptions;
	constructor(source: string, theme: Theme, options: ReportBodyOptions) {
		this.source = source;
		this.theme = theme;
		this.options = options;
		// No defaultTextStyle: Pi caches its default style prefix independently of invalidate().
		// Apply the fallback foreground/background outside Markdown so theme changes stay fresh.
		this.markdown = new Markdown(source, 0, 0, this.markdownTheme);
	}
	update(theme: Theme, options: ReportBodyOptions): void {
		this.theme = theme;
		this.options = options;
		this.invalidate();
	}
	invalidate(): void {
		Object.assign(this.markdownTheme, getMarkdownTheme());
		// Native Markdown retains its source-token cache while clearing themed/layout output.
		this.markdown.invalidate();
	}
	render(width: number): string[] {
		if (width <= 0) return [];
		const padding = Math.min(Math.max(0, Math.floor(this.options.padding ?? 0)), Math.max(0, Math.floor((width - 1) / 2)));
		const innerWidth = Math.max(1, width - 2 * padding);
		const header = this.options.header?.(innerWidth);
		const lines = [
			...(header ? new Text(header, 0, 0).render(innerWidth) : []),
			...this.markdown.render(innerWidth).map((line) => this.theme.fg("toolOutput", line)),
		];
		const background = this.options.background;
		return new Text(lines.join("\n"), padding, 0, background ? (text) => this.theme.bg(background, text) : undefined)
			.render(width).map((line) => truncateToWidth(line, width));
	}
}

/** Keep one native Markdown instance per report. Width changes reflow natively; invalidate() refreshes
 * theme/layout, not source tokens. Tool callbacks can also reuse Pi's lastComponent across redraws.
 * No global transcript/content cache: old reports are reclaimed with their host components. */
export function createReportBody(text: string, theme: Theme, options: ReportBodyOptions = {}, previous?: Component): Component {
	const source = sanitizeTerminalText(text);
	if (previous instanceof ReportBody && previous.source === source) {
		previous.update(theme, options);
		return previous;
	}
	return new ReportBody(source, theme, options);
}
