import assert from "node:assert/strict";
import test from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { getCellDimensions, resetCapabilitiesCache, setCapabilities, setCellDimensions, visibleWidth } from "@earendil-works/pi-tui";
// Test-only deep import: Node resolves it here, but Pi's extension loader cannot, so `src` must not.
import { calculateImageCellSize } from "@earendil-works/pi-tui/dist/terminal-image.js";
import { nativeImageColumns } from "../../../src/core/image-preview.ts";
import { createImagePreview } from "../../../src/ui/image-preview.ts";
const theme = { fg: (_:string, text:string) => text } as unknown as Theme;
const data = { path:"example.png", sourceMime:"image/png", sourceBytes:70, sourceWidth:1, sourceHeight:2, width:1, height:2, pngBase64:Buffer.from("89504e470d0a1a0a0000000d494844520000000100000002", "hex").toString("base64"), thumbnail:{width:1,height:2,rgbaBase64:Buffer.from([255,0,0,255,0,0,0,0]).toString("base64")}, frame:"first" as const };

test("cell previews center within the available width and remain bounded on resize", () => {
 const component=createImagePreview(data,{theme,showImages:true,expanded:false,mode:"ascii"});
 for(const width of [1,2,5,30,80]) {
  const rows=component.render(width);
  assert.equal(rows.length,1);
  assert.equal(rows[0]!.length,Math.floor((width-1)/2)+1);
  assert.ok(rows[0]!.startsWith(" ".repeat(Math.floor((width-1)/2))));
  assert.ok(rows.every(line=>visibleWidth(line)<=width));
 }
});

test("cell previews use the theme appearance for luminance and transparent pixels", () => {
 const image={...data,width:3,sourceWidth:3,pngBase64:Buffer.from("89504e470d0a1a0a0000000d494844520000000300000002","hex").toString("base64"),
  thumbnail:{width:3,height:2,rgbaBase64:Buffer.from([0,0,0,255,255,255,255,255,255,0,0,0,0,0,0,255,255,255,255,255,255,0,0,0]).toString("base64")}};
 const dark={...theme,appearance:"dark"} as Theme;
 const light={...theme,appearance:"light"} as Theme;
 assert.deepEqual(createImagePreview(image,{theme:dark,showImages:true,expanded:false,mode:"ascii"}).render(3),[" @ "]);
 assert.deepEqual(createImagePreview(image,{theme:light,showImages:true,expanded:false,mode:"ascii"}).render(3),["@  "]);
});

test("native Kitty and iTerm2 previews center their actual image reservation", () => {
 const keys=["TERM_PROGRAM","TERM","LC_ALL","NO_COLOR","PI_IMAGE_PROTOCOL"] as const;
 const saved=Object.fromEntries(keys.map(key=>[key,process.env[key]]));
 const previousCells=getCellDimensions();
 try {
  process.env.TERM_PROGRAM="kitty"; process.env.TERM="xterm"; process.env.LC_ALL="C.UTF-8";
  delete process.env.NO_COLOR; delete process.env.PI_IMAGE_PROTOCOL;
  setCellDimensions({widthPx:9,heightPx:18});
  for(const protocol of ["kitty","iterm2"] as const) {
   setCapabilities({images:protocol,trueColor:true,hyperlinks:false});
   const component=createImagePreview(data,{theme,showImages:true,expanded:false,mode:"auto"});
   for(const width of [1,2,5,30,80]) {
    const rows=component.render(width);
    const columns=Math.min(Math.max(1,width-2),8);
    const placement=rows.find(line=>line.includes(protocol==="kitty"?"\x1b_G":"\x1b]1337;File="))!;
    assert.ok(placement.startsWith(" ".repeat(Math.floor((width-columns)/2))+"\x1b"),`${protocol} width ${width}`);
    assert.equal(rows.length,columns,"host row accounting is preserved");
    assert.match(placement,new RegExp(protocol==="kitty"?`(?:^|,)c=${columns}(?:,|;)`:`;width=${columns};`));
    assert.ok(Math.floor((width-columns)/2)+columns<=width,"the native image reservation fits");
    assert.equal(rows.filter(Boolean).length,1,"blank image reservation rows have no extra text");
   }
  }
 } finally {
  setCellDimensions(previousCells);
  for(const key of keys) {if(saved[key]===undefined) delete process.env[key]; else process.env[key]=saved[key];}
  resetCapabilitiesCache();
 }
});

test("native cell-dimension changes invalidate the host image at the same width", () => {
 const keys=["TERM_PROGRAM","TERM","LC_ALL","NO_COLOR","PI_IMAGE_PROTOCOL"] as const;
 const saved=Object.fromEntries(keys.map(key=>[key,process.env[key]]));
 const previousCells=getCellDimensions();
 try {
  process.env.TERM_PROGRAM="kitty"; process.env.TERM="xterm"; process.env.LC_ALL="C.UTF-8";
  delete process.env.NO_COLOR; delete process.env.PI_IMAGE_PROTOCOL;
  setCapabilities({images:"kitty",trueColor:true,hyperlinks:false});
  setCellDimensions({widthPx:9,heightPx:18});
  const component=createImagePreview(data,{theme,showImages:true,expanded:false,mode:"auto"});
  assert.match(component.render(80)[0]!,/^ {36}\x1b_G[^;]*,c=8,r=8/);
  setCellDimensions({widthPx:9,heightPx:9});
  assert.match(component.render(80)[0]!,/^ {38}\x1b_G[^;]*,c=4,r=8/);
 } finally {
  setCellDimensions(previousCells);
  for(const key of keys) {if(saved[key]===undefined) delete process.env[key]; else process.env[key]=saved[key];}
  resetCapabilitiesCache();
 }
});
test("showImages false prevents graphics and remains explicit", () => {
 setCapabilities({images:"kitty",trueColor:true,hyperlinks:false});
 try {const rows=createImagePreview(data,{theme,showImages:false,expanded:false,mode:"auto"}).render(30); assert.match(rows.join(""),/disabled/i); assert.doesNotMatch(rows.join(""),/\x1b_G|\x1b\]1337/);}
 finally {resetCapabilitiesCache();}
});
test("auto uses host native graphics and dynamically falls back when unavailable", () => {
 const oldProgram=process.env.TERM_PROGRAM; process.env.TERM_PROGRAM="kitty";
 const oldTerm=process.env.TERM, oldLocale=process.env.LC_ALL, oldColor=process.env.NO_COLOR; process.env.TERM="xterm"; process.env.LC_ALL="C.UTF-8"; delete process.env.NO_COLOR;
 const component=createImagePreview(data,{theme,showImages:true,expanded:true,mode:"auto"});
 try {setCapabilities({images:"kitty",trueColor:true,hyperlinks:false}); assert.match(component.render(30).join(""),/\x1b_G/);
 setCapabilities({images:null,trueColor:true,hyperlinks:false}); assert.doesNotMatch(component.render(30).join(""),/\x1b_G|\x1b\]1337/);}
 finally {if(oldProgram===undefined) delete process.env.TERM_PROGRAM; else process.env.TERM_PROGRAM=oldProgram; if(oldTerm===undefined) delete process.env.TERM; else process.env.TERM=oldTerm; if(oldLocale===undefined) delete process.env.LC_ALL; else process.env.LC_ALL=oldLocale; if(oldColor===undefined) delete process.env.NO_COLOR; else process.env.NO_COLOR=oldColor; resetCapabilitiesCache();}
});
test("ascii mode never outputs escape sequences and handles narrow widths", () => {
 const component=createImagePreview(data,{theme,showImages:true,expanded:false,mode:"ascii"});
 assert.deepEqual(component.render(0),[]); for(const row of component.render(1)) assert.match(row,/^[ -~]{0,1}$/);
});

test("malformed persisted previews are bounded and produce a safe textual fallback", () => {
 for (const malformed of [null, {...data,thumbnail:{width:161,height:1,rgbaBase64:""}}, {...data,pngBase64:"A".repeat(3_000_000)}, {...data,thumbnail:{width:1,height:2,rgbaBase64:"!!!!"}}]) {
  const rows=createImagePreview(malformed as typeof data,{theme,showImages:true,expanded:true,mode:"auto"}).render(60);
  assert.match(rows.join(""),/unavailable/i);
 }
});

test("native protocol changes invalidate host Image cache at equal width", () => {
 const oldProgram=process.env.TERM_PROGRAM; process.env.TERM_PROGRAM="kitty";
 const oldTerm=process.env.TERM, oldLocale=process.env.LC_ALL, oldColor=process.env.NO_COLOR; process.env.TERM="xterm"; process.env.LC_ALL="C.UTF-8"; delete process.env.NO_COLOR;
 const component=createImagePreview(data,{theme,showImages:true,expanded:true,mode:"auto"});
 try {setCapabilities({images:"kitty",trueColor:true,hyperlinks:false}); assert.match(component.render(30).join(""),/\x1b_G/);
 setCapabilities({images:"iterm2",trueColor:true,hyperlinks:false}); assert.match(component.render(30).join(""),/\x1b\]1337;File=/);}
 finally {if(oldProgram===undefined) delete process.env.TERM_PROGRAM; else process.env.TERM_PROGRAM=oldProgram; if(oldTerm===undefined) delete process.env.TERM; else process.env.TERM=oldTerm; if(oldLocale===undefined) delete process.env.LC_ALL; else process.env.LC_ALL=oldLocale; if(oldColor===undefined) delete process.env.NO_COLOR; else process.env.NO_COLOR=oldColor; resetCapabilitiesCache();}
});

test("history requires PNG signature and IHDR dimensions matching metadata", () => {
 const bad={...data,pngBase64:Buffer.from('not a png').toString('base64')};
 assert.match(createImagePreview(bad,{theme,showImages:true,expanded:true,mode:'auto'}).render(80).join(''),/unavailable/);
 const wrong={...data,width:2};
 assert.match(createImagePreview(wrong,{theme,showImages:true,expanded:true,mode:'auto'}).render(80).join(''),/unavailable/);
});

test("large bounded PNG payload metadata validates without stack overflow", () => {
 const bytes=Buffer.alloc(1_400_000);
 Buffer.from("89504e470d0a1a0a0000000d494844520000000100000002", "hex").copy(bytes);
 const large={...data,pngBase64:bytes.toString('base64')};
 assert.doesNotThrow(() => createImagePreview(large,{theme,showImages:true,expanded:true,mode:'ascii'}).render(10));
});

test("C.UTF-8 supports colored blocks while C and NO_COLOR use plain ASCII", () => {
 const saved={LC_ALL:process.env.LC_ALL,LC_CTYPE:process.env.LC_CTYPE,LANG:process.env.LANG,NO_COLOR:process.env.NO_COLOR,TERM:process.env.TERM};
 try {
  delete process.env.LC_CTYPE; delete process.env.LANG; delete process.env.NO_COLOR; process.env.TERM="xterm";
  setCapabilities({images:null,trueColor:true,hyperlinks:false});
  const component=createImagePreview(data,{theme,showImages:true,expanded:true,mode:"ansi"});
  process.env.LC_ALL="C.UTF-8"; assert.match(component.render(10).join(""),/▀/);
  process.env.LC_ALL="C"; assert.doesNotMatch(component.render(10).join(""),/\x1b|▀/);
  process.env.LC_ALL="C.UTF-8"; process.env.NO_COLOR="1"; assert.doesNotMatch(component.render(10).join(""),/\x1b|▀/);
 } finally {
  for(const [key,value] of Object.entries(saved)) { if(value === undefined) delete process.env[key]; else process.env[key]=value; }
  resetCapabilitiesCache();
 }
});

test("NO_COLOR and dumb terminals force ASCII even when graphics are advertised", () => {
 const oldColor=process.env.NO_COLOR, oldTerm=process.env.TERM;
 try {
  setCapabilities({images:"kitty",trueColor:true,hyperlinks:false});
  const component=createImagePreview(data,{theme,showImages:true,expanded:true,mode:"auto"});
  process.env.NO_COLOR="1"; assert.match(component.render(30).join(""),/^[ -~]*$/);
  delete process.env.NO_COLOR; process.env.TERM="dumb"; assert.match(component.render(30).join(""),/^[ -~]*$/);
 } finally {
  if(oldColor===undefined) delete process.env.NO_COLOR; else process.env.NO_COLOR=oldColor;
  if(oldTerm===undefined) delete process.env.TERM; else process.env.TERM=oldTerm;
  resetCapabilitiesCache();
 }
});

test("native column reservation matches the host geometry it mirrors", () => {
 for(const cell of [{widthPx:9,heightPx:18},{widthPx:10,heightPx:22},{widthPx:7,heightPx:15}])
  for(const [width,height] of [[1,2],[3,2],[640,480],[480,640],[1200,90],[90,1200],[160,160],[641,17]] as const)
   for(const maxColumns of [1,2,7,28,60]) for(const maxRows of [1,8,20]) for(const optimize of [false,true])
    assert.equal(nativeImageColumns({width,height},maxColumns,maxRows,cell,optimize),
     calculateImageCellSize({widthPx:width,heightPx:height},maxColumns,maxRows,cell,optimize).columns,
     JSON.stringify({cell,width,height,maxColumns,maxRows,optimize}));
});
