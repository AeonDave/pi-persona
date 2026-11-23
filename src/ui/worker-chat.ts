/** Read-only worker conversation: no session handle, filesystem, tool execution or renderer loading. */
import type { Theme } from "@earendil-works/pi-coding-agent";
import { Input, getKeybindings, setKeybindings, matchesKey, truncateToWidth, wrapTextWithAnsi,
	type Component, type KeybindingsManager, type TuiMouseEvent } from "@earendil-works/pi-tui";
import type { WorkerChatBlock, WorkerChatSnapshot } from "../core/worker-chat.ts";
import { ChatViewport, type ChatRows } from "./chat-viewport.ts";
import { compactInlineText, compactLiteralText, sanitizeTerminalText } from "./presentation.ts";
import { createReportBody } from "./report-body.ts";

interface CachedBlock { block: WorkerChatBlock; width: number; expanded: boolean; markdown: boolean; lines: string[]; component?: Component }

/** Find across word/hard wraps without restarting the reader at a long tool's header. */
function matchingRow(lines: readonly string[], query: string): number {
	const needle = query.toLocaleLowerCase().replace(/\s+/g, " ").trim();
	const plain = lines.map((line) => sanitizeTerminalText(line).toLocaleLowerCase().replace(/\s+/g, " ").trim());
	for (const separator of [" ", ""]) {
		const offset = plain.join(separator).indexOf(needle);
		if (offset < 0) continue;
		let start = 0;
		for (let row = 0; row < plain.length; row++) {
			const end = start + plain[row]!.length + separator.length;
			if (offset < end) return row;
			start = end;
		}
	}
	return 0;
}

export class WorkerChatView {
	private snapshot: WorkerChatSnapshot = { blocks: [], truncated: false };
	private readonly viewport = new ChatViewport();
	private readonly cache = new Map<string, CachedBlock>();
	private readonly expanded = new Set<string>();
	private expandAll = false;
	private readonly theme: Theme;
	private readonly keys: KeybindingsManager;
	private input = new Input({ prompt: "" });
	private searchOpen = false;
	private query = "";
	private matches: string[] = [];
	private matchIndex = -1;
	private matchSnapshot: WorkerChatSnapshot | undefined;
	private matchQuery = "";
	private readonly searchCache = new Map<string, { block: WorkerChatBlock; query: string; found: boolean }>();
	private focus = false;
	private width = 1;
	private height = 1;
	private pageRows = 1;
	private pageIds: string[] = [];
	private pageOffsets: number[] = [];
	private pendingMatch: string | undefined;
	private markdown = true;
	private searchLiteralBlock: string | undefined;
	private renders = 0;

	constructor(theme: Theme, keys: KeybindingsManager) {
		this.theme = theme;
		this.keys = keys;
		this.resetInput();
	}
	get searching(): boolean { return this.searchOpen; }
	get renderedBlockCount(): number { return this.renders; }
	set focused(value: boolean) { this.focus = value; this.input.focused = value && this.searchOpen; }
	update(snapshot: WorkerChatSnapshot): void { this.snapshot = snapshot; }
	invalidate(): void { this.cache.clear(); this.input.invalidate(); }

	private resetInput(): void {
		this.input = new Input({ prompt: "" });
		this.input.onSubmit = () => {
			this.query = sanitizeTerminalText(this.input.getValue()).trim();
			this.searchOpen = false;
			this.input.focused = false;
			this.refreshMatches();
			this.matchIndex = -1;
			this.nextMatch(1);
		};
		this.input.onEscape = () => { this.searchOpen = false; this.input.focused = false; };
	}

	handleInput(data: string): boolean {
		if (this.searchOpen) {
			const current = getKeybindings();
			try {
				if (current !== this.keys) setKeybindings(this.keys);
				this.input.handleInput(data);
				const clean = sanitizeTerminalText(this.input.getValue());
				if (clean !== this.input.getValue()) this.input.setValue(clean);
			} finally { if (current !== this.keys) setKeybindings(current); }
			return true;
		}
		if (data === "/" || this.keys.matches(data, "tui.altScreen.search")) {
			this.resetInput();
			this.input.setValue(this.query);
			this.searchOpen = true;
			this.input.focused = this.focus;
		} else if (data === "n" || this.keys.matches(data, "tui.altScreen.searchNext")) this.nextMatch(1);
		else if (data === "N" || this.keys.matches(data, "tui.altScreen.searchPrevious")) this.nextMatch(-1);
		else if (this.keys.matches(data, "app.tools.expand") || data === "e") this.toggleExpanded();
		else if (data === "m") this.markdown = !this.markdown;
		else if (matchesKey(data, "home") || this.keys.matches(data, "tui.altScreen.top")) this.viewport.start();
		else if (matchesKey(data, "end") || this.keys.matches(data, "tui.altScreen.bottom")) this.viewport.end();
		else if (this.keys.matches(data, "tui.select.pageUp") || this.keys.matches(data, "tui.altScreen.pageUp")) this.viewport.scrollBy(-Math.max(1, this.pageRows - 1));
		else if (this.keys.matches(data, "tui.select.pageDown") || this.keys.matches(data, "tui.altScreen.pageDown")) this.viewport.scrollBy(Math.max(1, this.pageRows - 1));
		else if (this.keys.matches(data, "tui.select.up") || data === "k") this.viewport.scrollBy(-1);
		else if (this.keys.matches(data, "tui.select.down") || data === "j") this.viewport.scrollBy(1);
		else return false;
		return true;
	}

	handleMouse(event: TuiMouseEvent): boolean {
		if (event.y < 0 || event.y >= this.height) return false;
		if (event.type === "wheel") {
			this.viewport.scrollBy(event.wheelDelta ?? 0);
			return true;
		}
		if (event.type === "click" && event.button === "left") {
			const id = this.pageIds[event.y];
			const block = this.snapshot.blocks.find((candidate) => candidate.id === id);
			if (block && this.pageOffsets[event.y] === 0 && (block.kind === "tool" || block.kind === "thinking")) {
				if (!this.expanded.delete(block.id)) this.expanded.add(block.id);
				return true;
			}
		}
		return false;
	}

	toggleExpanded(): void {
		this.expandAll = !this.expandAll;
		this.expanded.clear();
	}

	render(width: number, height: number): string[] {
		this.width = Math.max(1, Math.floor(width));
		this.height = Math.max(1, Math.floor(height));
		if (this.height === 1 && this.searchOpen) {
			this.pageIds = [];
			this.pageOffsets = [];
			return this.input.render(this.width).slice(0, 1);
		}
		this.refreshMatches();
		const blocks: ChatRows[] = this.snapshot.blocks.map((block) => ({ id: block.id, lines: this.blockRows(block) }));
		if (blocks.length === 0) blocks.push({ id: "empty", lines: ["(waiting for worker messages)"] });
		const ids = new Set(this.snapshot.blocks.map((block) => block.id));
		for (const id of this.cache.keys()) if (!ids.has(id)) this.cache.delete(id);
		for (const id of this.expanded) if (!ids.has(id)) this.expanded.delete(id);
		for (const id of this.searchCache.keys()) if (!ids.has(id)) this.searchCache.delete(id);
		this.viewport.setBlocks(blocks);
		this.pageRows = Math.max(1, this.height - Number(this.height > 1));
		// Set capacity before a search jump, whose clamp depends on the current viewport.
		this.viewport.render(this.pageRows);
		if (this.pendingMatch) {
			const match = blocks.find((block) => block.id === this.pendingMatch);
			this.viewport.jumpTo(this.pendingMatch, match ? matchingRow(match.lines, this.query) : 0);
			this.pendingMatch = undefined;
		}
		const page = this.viewport.render(this.pageRows);
		this.pageIds = page.ids;
		this.pageOffsets = page.rowOffsets;
		const lines = [...page.lines];
		if (this.height > 1) {
			while (lines.length < this.pageRows) lines.push("");
			if (this.searchOpen) {
				const prefix = this.width >= 4 ? "/ " : "";
				lines.push(prefix + (this.input.render(Math.max(1, this.width - prefix.length))[0] ?? ""));
			} else {
				const status = [this.snapshot.truncated ? "partial run chat · earlier/payload trimmed" : "run chat",
					this.query ? `${this.matches.length ? this.matchIndex + 1 : 0}/${this.matches.length} matching blocks` : "",
					this.viewport.following ? "latest" : `${page.newer} newer rows · End latest`].filter(Boolean).join(" · ");
				lines.push(this.theme.fg("dim", status));
			}
		}
		return lines.map((line) => truncateToWidth(line, this.width, "…"));
	}

	private isExpanded(id: string): boolean { return this.expandAll !== this.expanded.has(id); }
	private blockRows(block: WorkerChatBlock): string[] {
		const expanded = this.isExpanded(block.id);
		const markdown = block.kind === "assistant" && this.markdown && block.id !== this.searchLiteralBlock;
		const old = this.cache.get(block.id);
		if (old?.block === block && old.width === this.width && old.expanded === expanded && old.markdown === markdown) return old.lines;
		this.renders++;
		const t = this.theme;
		let title: string, body: string;
		if (block.kind === "tool") {
			title = `⚙ ${compactInlineText(block.name)} · ${block.status}${expanded ? "" : " · e expand"}`;
			body = expanded
				? `arguments:\n${block.arguments || "(none recorded)"}\nresult:\n${block.output || (block.status === "running" ? "(running…)" : "(no output recorded)")}`
				: (block.output || block.arguments || "(running…)");
		} else {
			title = block.kind;
			body = block.text;
			if (block.kind === "thinking" && !expanded) {
				title += " · e expand";
			}
		}
		const token = block.kind === "tool" && block.status === "failed" || block.kind === "status" && block.level === "error" ? "error" : "accent";
		let component: Component | undefined;
		const clean = sanitizeTerminalText(body);
		if (markdown) {
			try { component = createReportBody(clean, t, {}, old?.block === block ? old.component : undefined); }
			catch { /* Embedded hosts/tests without Pi's initialized theme use the literal rendering. */ }
		}
		const collapsed = !expanded && (block.kind === "tool" || block.kind === "thinking");
		const content = collapsed ? compactLiteralText(clean, 2, this.width).text.split("\n")
			: component ? component.render(this.width) : clean.split("\n").flatMap((line) => wrapTextWithAnsi(line, this.width));
		const lines = [t.fg(token, t.bold(title)), ...content];
		this.cache.set(block.id, { block, width: this.width, expanded, markdown, lines, ...(component ? { component } : {}) });
		return lines;
	}

	private refreshMatches(): void {
		if (this.matchSnapshot === this.snapshot && this.matchQuery === this.query) return;
		this.matchSnapshot = this.snapshot;
		this.matchQuery = this.query;
		const query = this.query.toLocaleLowerCase();
		const current = this.matches[this.matchIndex];
		this.matches = query ? this.snapshot.blocks.filter((block) => {
			const cached = this.searchCache.get(block.id);
			if (cached?.block === block && cached.query === query) return cached.found;
			const text = block.kind === "tool" ? `${block.name}\n${block.arguments}\n${block.output}` : block.text;
			const found = sanitizeTerminalText(text).toLocaleLowerCase().includes(query);
			this.searchCache.set(block.id, { block, query, found });
			return found;
		}).map((block) => block.id) : [];
		this.matchIndex = current ? this.matches.indexOf(current) : -1;
	}
	private nextMatch(delta: number): void {
		this.refreshMatches();
		if (!this.matches.length) return;
		this.matchIndex = (this.matchIndex + delta + this.matches.length) % this.matches.length;
		const id = this.matches[this.matchIndex]!;
		this.searchLiteralBlock = id;
		if (!this.isExpanded(id)) {
			if (this.expandAll) this.expanded.delete(id); else this.expanded.add(id);
		}
		this.pendingMatch = id;
	}
}
