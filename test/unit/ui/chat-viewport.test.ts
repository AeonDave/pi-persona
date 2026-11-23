import { test } from "node:test";
import assert from "node:assert/strict";

import { ChatViewport } from "../../../src/ui/chat-viewport.ts";

const blocks = (count: number) => Array.from({ length: count }, (_, i) => ({ id: `m${i}`, lines: [`message ${i}`] }));

test("scrolling up while all content fits keeps following the tail", () => {
	const viewport = new ChatViewport();
	viewport.setBlocks(blocks(3));
	viewport.render(10);
	viewport.scrollBy(-1);
	assert.equal(viewport.following, true);
	viewport.setBlocks(blocks(30));
	assert.equal(viewport.render(10).top, 20, "the view still tracks the streaming tail");
});

test("a zero-delta scroll is a no-op", () => {
	const viewport = new ChatViewport();
	viewport.setBlocks(blocks(30));
	viewport.render(10);
	viewport.scrollBy(0);
	assert.equal(viewport.following, true);
	viewport.scrollBy(-4);
	assert.equal(viewport.following, false);
	viewport.scrollBy(0);
	assert.equal(viewport.following, false, "a no-op never re-engages follow");
});

test("scrolling up from the tail stops following; scrolling back down resumes", () => {
	const viewport = new ChatViewport();
	viewport.setBlocks(blocks(30));
	viewport.render(10);
	viewport.scrollBy(-1);
	assert.equal(viewport.following, false);
	viewport.scrollBy(1);
	assert.equal(viewport.following, true);
});
