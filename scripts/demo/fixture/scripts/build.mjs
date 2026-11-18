// Stand-in build for the demo recordings: three steps, then a clean exit.
import { setTimeout as delay } from "node:timers/promises";

for (const step of ["compile", "bundle", "minify"]) {
	console.log(`build: ${step}`);
	await delay(2400);
}
console.log("build: done, 3 steps, 0 warnings");
