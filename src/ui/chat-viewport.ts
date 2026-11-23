/** A bounded block viewport. Identity, not distance from the tail, anchors reading. */
export interface ChatRows { readonly id: string; readonly lines: readonly string[] }
export interface ChatPage {
	lines: string[];
	ids: string[];
	rowOffsets: number[];
	top: number;
	total: number;
	newer: number;
}

export class ChatViewport {
	private blocks: readonly ChatRows[] = [];
	private starts: number[] = [];
	private total = 0;
	private top = 0;
	private height = 1;
	private anchor: { id: string; row: number } | undefined;
	private follow = true;

	get following(): boolean { return this.follow; }

	setBlocks(blocks: readonly ChatRows[]): void {
		this.blocks = blocks;
		this.starts = [];
		this.total = 0;
		for (const block of blocks) {
			this.starts.push(this.total);
			this.total += block.lines.length;
		}
		if (!this.follow && this.anchor) {
			const index = blocks.findIndex((block) => block.id === this.anchor!.id);
			this.top = index < 0 ? 0 : this.starts[index]! + Math.min(this.anchor.row, Math.max(0, blocks[index]!.lines.length - 1));
		}
		this.clamp();
	}

	render(height: number): ChatPage {
		this.height = Math.max(1, Math.floor(height));
		this.clamp();
		const lines: string[] = [], ids: string[] = [], rowOffsets: number[] = [];
		// At most the bounded block index is walked; cached text outside the viewport is never copied.
		for (let i = 0; i < this.blocks.length && lines.length < this.height; i++) {
			const block = this.blocks[i]!;
			const start = this.starts[i]!;
			if (start + block.lines.length <= this.top) continue;
			const offset = Math.max(0, this.top - start);
			for (let row = offset; row < block.lines.length && lines.length < this.height; row++) {
				lines.push(block.lines[row]!);
				ids.push(block.id);
				rowOffsets.push(row);
			}
		}
		this.captureAnchor();
		return { lines, ids, rowOffsets, top: this.top, total: this.total, newer: Math.max(0, this.total - this.top - this.height) };
	}

	scrollBy(delta: number): void {
		const step = Math.trunc(delta);
		if (step === 0) return;
		this.top = Math.max(0, Math.min(this.maxTop(), this.top + step));
		// Following changes only when the view can actually leave (or return to) the tail.
		if (step > 0) this.follow = this.top === this.maxTop();
		else if (this.maxTop() > 0) this.follow = false;
		this.captureAnchor();
	}
	start(): void { this.top = 0; this.follow = false; this.captureAnchor(); }
	end(): void { this.follow = true; this.clamp(); this.captureAnchor(); }
	jumpTo(id: string, row = 0): void {
		const index = this.blocks.findIndex((block) => block.id === id);
		if (index < 0) return;
		this.follow = false;
		this.top = Math.min(this.maxTop(), this.starts[index]! + Math.max(0, row));
		this.captureAnchor();
	}

	private maxTop(): number { return Math.max(0, this.total - this.height); }
	private clamp(): void { this.top = this.follow ? this.maxTop() : Math.min(this.top, this.maxTop()); }
	private captureAnchor(): void {
		const index = this.starts.findLastIndex((start) => start <= this.top);
		const block = this.blocks[index];
		this.anchor = block ? { id: block.id, row: this.top - this.starts[index]! } : undefined;
	}
}
