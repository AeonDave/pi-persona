import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PNG } from "pngjs";
import { initTheme, ToolExecutionComponent, type ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { getCapabilities, getKeybindings, KeybindingsManager, resetCapabilitiesCache, setCapabilities, setKeybindings, type TUI, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { stripVTControlCharacters } from "node:util";
import { makeShowImageTool } from "../../../src/tools/show-image.ts";

test("show_image prepares a bounded display payload without sending pixels to the model", async () => {
	const dir = await mkdtemp(join(tmpdir(), "persona-show-image-"));
	try {
		const pixel = new PNG({ width: 1, height: 1 });
		pixel.data.set([255, 0, 0, 128]);
		await writeFile(join(dir, "sample.png"), PNG.sync.write(pixel));
		const tool = makeShowImageTool();
		const result = await tool.execute("preview", { path: "sample.png", mode: "ascii" }, undefined, undefined,
			{ cwd: dir, hasUI: false } as ExtensionToolContext);
		assert.equal(result.isError, false);
		assert.deepEqual(result.content.map((part) => part.type), ["text"]);
		assert.match(result.content[0]!.type === "text" ? result.content[0]!.text : "", /no interactive display/i);
		assert.equal(result.details?.mode, "ascii");
		assert.equal(result.details?.image?.sourceWidth, 1);
		assert.equal(result.details?.image?.sourceHeight, 1);
		assert.equal(result.details?.image?.path, join(dir, "sample.png"));
		assert.ok(result.details?.image?.pngBase64);
		assert.ok(!JSON.stringify(result.content).includes(result.details!.image!.pngBase64));
	} finally { await rm(dir, { recursive: true, force: true }); }
});

test("show_image rechecks grants before reading a file and reports errors as failures", async () => {
	let allowed = false;
	let checks = 0;
	const tool = makeShowImageTool({ authorize: () => { checks++; return allowed; } });
	const context = { cwd: process.cwd(), hasUI: true } as ExtensionToolContext;
	const denied = await tool.execute("denied", { path: "missing.png" }, undefined, undefined, context);
	assert.equal(denied.isError, true);
	assert.match(JSON.stringify(denied.content), /not authorized/);
	allowed = true;
	const missing = await tool.execute("missing", { path: "missing.png" }, undefined, undefined, context);
	assert.equal(missing.isError, true);
	assert.match(JSON.stringify(missing.content), /ENOENT|no such file/);
	assert.equal(checks, 2);
	assert.equal(missing.details?.image, undefined);
});

test("show_image rejects invalid modes, empty paths and cancellation through direct calls", async () => {
	const tool = makeShowImageTool();
	const context = { cwd: process.cwd(), hasUI: true } as ExtensionToolContext;
	for (const params of [{ path: "" }, { path: "missing.png", mode: "sixel" }]) {
		const result = await tool.execute("bad", params as never, undefined, undefined, context);
		assert.equal(result.isError, true);
		assert.doesNotMatch(JSON.stringify(result.content), /ENOENT/);
	}
	const abort = new AbortController(); abort.abort();
	const result = await tool.execute("cancelled", { path: "missing.png" }, abort.signal, undefined, context);
	assert.equal(result.isError, true);
	assert.match(JSON.stringify(result.content), /cancel|abort/i);
});

test("show_image renders and expands through Pi's real native tool shell", async () => {
 initTheme("dark", false);
 const previousKeys = getKeybindings();
 setKeybindings(new KeybindingsManager({"app.tools.expand": {defaultKeys:"ctrl+o", description:"Expand tool output"}}));
 setCapabilities({images:null,trueColor:true,hyperlinks:false});
 const dir=await mkdtemp(join(tmpdir(),"persona-show-image-ui-"));
 try {
  const image=new PNG({width:24,height:96}); image.data.fill(255);
  await writeFile(join(dir,"sample.png"),PNG.sync.write(image));
  const tool=makeShowImageTool();
  const result=await tool.execute("preview",{path:"sample.png",mode:"ascii"},undefined,undefined,{cwd:dir,hasUI:true} as ExtensionToolContext);
  const component=new ToolExecutionComponent("show_image","preview",{path:"sample.png",mode:"ascii"},{showImages:true,outputPad:2},tool,{requestRender(){}} as unknown as TUI,dir);
  component.updateResult({...result,isError:false});
  const collapsed=component.render(40);
  const text=stripVTControlCharacters(collapsed.join("\n"));
  assert.match(text,/show_image.*sample\.png/); assert.match(text,/preview/); assert.match(text,/ctrl\+o/i);
  assert.ok(!text.includes("Prepared a terminal preview"),"the model-facing result is not duplicated into the card");
  assert.ok(collapsed.every(line=>stripVTControlCharacters(line).length<=40));
  const y=collapsed.length-2;
  const click:TuiMouseEvent={type:"click",button:"left",x:3,y,screenX:3,screenY:y,width:40,height:collapsed.length,shift:false,alt:false,ctrl:false};
  assert.equal(component.handleMouse(click)?.handled,true);
  const expanded=component.render(40);
  assert.ok(expanded.length>collapsed.length,"native click reveals a taller preview");
  component.setExpanded(false);
  assert.equal(component.render(40).length,collapsed.length,"host keyboard state restores collapsed view");
  component.setShowImages(false);
  assert.match(stripVTControlCharacters(component.render(40).join("\n")),/image previews disabled/i);
  for(const width of [1,2,5,20,40]) assert.ok(component.render(width).every(line=>stripVTControlCharacters(line).length<=width),`width ${width}`);
 } finally {await rm(dir,{recursive:true,force:true}); resetCapabilitiesCache(); setKeybindings(previousKeys);}
});

test("show_image native shell handles errors and malformed persisted image details", () => {
 initTheme("dark",false);
 const tool=makeShowImageTool();
 const component=new ToolExecutionComponent("show_image","saved",{path:"example.png"},{showImages:true,outputPad:1},tool,{requestRender(){}} as unknown as TUI,process.cwd());
 component.updateResult({content:[{type:"text",text:"show_image: file missing"}],details:{mode:"auto"},isError:true});
 let text=stripVTControlCharacters(component.render(60).join("\n"));
 assert.match(text,/failed/); assert.match(text,/file missing/);
 component.updateResult({content:[{type:"text",text:"saved image"}],details:{mode:"auto",image:{pngBase64:"bogus"}},isError:false});
 text=stripVTControlCharacters(component.render(60).join("\n"));
 assert.match(text,/preview unavailable/i);
});

test("auto show_image renders saved color pixels in Herdr without an outer graphics capability", async () => {
	const keys = ["TERM_PROGRAM", "TERM", "COLORTERM", "LC_ALL", "NO_COLOR", "PI_IMAGE_PROTOCOL", "TMUX", "WT_SESSION"] as const;
	const saved = Object.fromEntries(keys.map(key => [key, process.env[key]]));
	const dir = await mkdtemp(join(tmpdir(), "persona-show-image-herdr-"));
	try {
		// Herdr advertises Kitty to Pi but removes the outer terminal's markers.
		process.env.TERM_PROGRAM = "herdr";
		process.env.TERM = "xterm-256color";
		process.env.COLORTERM = "truecolor";
		process.env.LC_ALL = "C.UTF-8";
		for (const key of ["NO_COLOR", "PI_IMAGE_PROTOCOL", "TMUX", "WT_SESSION"]) delete process.env[key];
		resetCapabilitiesCache();
		assert.equal(getCapabilities().images, "kitty");
		initTheme("dark", false);
		const image = new PNG({ width: 128, height: 128 });
		for (let y = 0; y < 128; y++) for (let x = 0; x < 128; x++) {
			image.data.set(x >= 32 && x < 96 && y >= 32 && y < 96 ? [255, 208, 0, 255] : [0, 0, 0, 255], (y * 128 + x) * 4);
		}
		await writeFile(join(dir, "sample.png"), PNG.sync.write(image));
		const tool = makeShowImageTool();
		const result = await tool.execute("preview", { path: "sample.png" }, undefined, undefined, { cwd: dir, hasUI: true } as ExtensionToolContext);
		assert.equal(result.isError, false);
		const component = new ToolExecutionComponent("show_image", "preview", { path: "sample.png" }, { showImages: true }, tool, { requestRender() {} } as unknown as TUI, dir);
		component.updateResult(JSON.parse(JSON.stringify(result)));
		const rows = component.render(80);
		assert.equal(rows.filter(line => line.includes("▀")).length, 8);
		assert.match(rows.join(""), /\x1b\[38;2;255;208;0m/);
		assert.doesNotMatch(rows.join(""), /\x1b_G|\x1b\]1337;File=/);
		// The documented Pi override opts a known-compatible outer terminal back in.
		for (const [protocol, sequence] of [["kitty", "\x1b_G"], ["iterm2", "\x1b]1337;File="]] as const) {
			process.env.PI_IMAGE_PROTOCOL = protocol;
			resetCapabilitiesCache();
			assert.ok(component.render(80).join("").includes(sequence));
		}
		process.env.NO_COLOR = "1";
		const plain = component.render(80).join("");
		assert.doesNotMatch(plain, /\x1b_G|\x1b\]1337;File=|▀/);
		assert.match(stripVTControlCharacters(plain), /#{8}/);
	} finally {
		await rm(dir, { recursive: true, force: true });
		for (const key of keys) { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; }
		resetCapabilitiesCache();
	}
});
