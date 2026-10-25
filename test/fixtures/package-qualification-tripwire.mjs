// Preloaded before Pi, inherited by its actual child CLI. Never permit HTTP/model traffic.
import { appendFileSync } from "node:fs";
import net from "node:net";
import http from "node:http";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";

appendFileSync(process.env.PACKAGE_QUALIFICATION_RECEIPTS, `${JSON.stringify({ event: "network_tripwire_armed", pid: process.pid })}\n`);
const block = (transport) => {
	appendFileSync(process.env.PACKAGE_QUALIFICATION_RECEIPTS, `${JSON.stringify({ event: "network_blocked", transport, pid: process.pid })}\n`);
	throw new Error(`Package qualification network tripwire: ${transport}`);
};
globalThis.fetch = async () => block("fetch");
for (const transport of [http, https]) {
	transport.request = () => block("http");
	transport.get = () => block("http");
}
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
	// node:net normalizes public connect arguments to [options, callback]. Permit only the
	// local semantic broker (Unix socket / Windows pipe / loopback), never Internet sockets.
	let options = args[0];
	if (Array.isArray(options)) options = options[0];
	if (typeof options === "string" && !/^\d+$/.test(options)) return connect.apply(this, args);
	const host = typeof options === "object" ? options?.host : args[1];
	if ((typeof options === "object" && options?.path) || ["127.0.0.1", "::1", "localhost"].includes(host)) return connect.apply(this, args);
	return block("socket");
};
syncBuiltinESMExports();
