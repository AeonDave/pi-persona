import assert from "node:assert/strict";
import test from "node:test";
import { resizeRgba, renderImageCells, useNativeImagePreview } from "../../../src/core/image-preview.ts";

test("native preview needs explicit graphics selection inside Herdr's opaque outer terminal", () => {
	assert.equal(useNativeImagePreview("kitty", "herdr"), false);
	assert.equal(useNativeImagePreview("kitty", "HERDR", "invalid"), false);
	assert.equal(useNativeImagePreview("kitty", "herdr", "kitty"), true);
	assert.equal(useNativeImagePreview("iterm2", "herdr", "ITERM2"), true);
	assert.equal(useNativeImagePreview(null, "herdr", "kitty"), false, "host-disabled images remain disabled");
	assert.equal(useNativeImagePreview("kitty", "kitty"), true);
	assert.equal(useNativeImagePreview("iterm2", "iTerm.app"), true);
	assert.equal(useNativeImagePreview("kitty"), true);
	assert.equal(useNativeImagePreview(null, "Windows_Terminal"), false);
});

test("resizeRgba fits without enlargement and preserves RGBA", () => {
 const source = { width: 2, height: 2, data: Uint8Array.from([255,0,0,255, 0,255,0,128, 0,0,255,0, 255,255,255,255]) };
 assert.deepEqual(resizeRgba(source, 3, 3), source);
 const small = resizeRgba(source, 1, 1);
 assert.equal(small.width, 1); assert.equal(small.height, 1); assert.equal(small.data.length, 4);
 assert.throws(() => resizeRgba({...source, data:new Uint8Array(3)}, 1, 1));
});

test("downsampling retains fine lines and handles fractional pixel coverage", () => {
 const stripes = { width: 4, height: 1, data: Uint8Array.from([255,255,255,255, 0,0,0,255, 255,255,255,255, 0,0,0,255]) };
 assert.deepEqual([...resizeRgba(stripes, 2, 1).data], [128,128,128,255, 128,128,128,255]);
 const fractional = { width: 3, height: 1, data: Uint8Array.from([255,255,255,255, 0,0,0,255, 0,0,0,255]) };
 assert.deepEqual([...resizeRgba(fractional, 2, 1).data], [170,170,170,255, 0,0,0,255]);
 const cells = renderImageCells(stripes, { width: 2, height: 1, color: "truecolor", unicode: true, background: [0,0,0] });
 assert.match(cells[0]!, /38;2;128;128;128m/);
 assert.equal(renderImageCells(stripes, { width: 2, height: 1, color: "none", unicode: false, background: [0,0,0] })[0], "++");
});

test("downsampling weights color by opacity", () => {
 const image = { width: 2, height: 1, data: Uint8Array.from([255,0,0,255, 0,0,255,0]) };
 assert.deepEqual([...resizeRgba(image, 1, 1).data], [255,0,0,128]);
 const transparent = { width: 2, height: 1, data: Uint8Array.from([255,0,0,0, 0,0,255,0]) };
 assert.deepEqual([...resizeRgba(transparent, 1, 1).data], [0,0,0,0]);
});

test("cell renderer limits dimensions and composites alpha on an explicit background", () => {
 const image={width:1,height:2,data:Uint8Array.from([255,0,0,255,0,0,255,0])};
 const truecolor=renderImageCells(image,{width:1,height:1,color:"truecolor",unicode:true,background:[0,0,0]});
 assert.equal(truecolor.length,1); assert.match(truecolor[0]!,/\x1b\[38;2;255;0;0m/); assert.match(truecolor[0]!,/\x1b\[48;2;0;0;0m/);
 assert.match(renderImageCells(image,{width:1,height:1,color:"256",unicode:true,background:[0,0,0]})[0]!,/38;5;/);
 assert.match(renderImageCells(image,{width:1,height:1,color:"16",unicode:true,background:[0,0,0]})[0]!,/\x1b\[[39]/);
 const ascii=renderImageCells(image,{width:1,height:1,color:"none",unicode:false,background:[0,0,0]}).join("");
 assert.match(ascii,/^[ -~]+$/); assert.doesNotMatch(ascii,/\x1b/);
 assert.deepEqual(renderImageCells(image,{width:0,height:1,color:"none",unicode:false,background:[0,0,0]}),[]);
});

test("ASCII uses the background brightness so transparent pixels remain blank", () => {
 const image = { width: 3, height: 1, data: Uint8Array.from([0,0,0,255, 255,255,255,255, 255,0,0,0]) };
 const render = (background: readonly [number, number, number]) => renderImageCells(image, { width: 3, height: 1, color: "none", unicode: false, background }).join("");
 assert.equal(render([0,0,0]), " @ ");
 assert.equal(render([255,255,255]), "@  ");
 assert.doesNotMatch(render([255,255,255]), /\x1b/);
});
