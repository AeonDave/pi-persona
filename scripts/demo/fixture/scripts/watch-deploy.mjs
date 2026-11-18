// Stand-in deploy watcher for the demo recordings: silent until the release is live, then one line.
import { setTimeout as delay } from "node:timers/promises";

await delay(13_000);
console.log("deploy: v2.4.1 is live on production");
