import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { runQualificationProcess } from "../../scripts/lib/package-qualification-process.ts";
import * as qualification from "../../scripts/lib/package-qualification.ts";
import { MIN_PI_VERSION } from "../../src/core/pi-compat.ts";
import { inspectPackage, isRealPathWithin, qualificationEnv, resetCandidatePackage, waitForReceipt } from "../../scripts/lib/package-qualification.ts";

const manifest = {
	name: "@aeondave/pi-persona", version: "1.0.0", files: ["src", "README.md"],
	pi: { extensions: ["./src/extension.ts"] },
	peerDependencies: Object.fromEntries(["@earendil-works/pi-coding-agent", "@earendil-works/pi-agent-core", "@earendil-works/pi-ai", "@earendil-works/pi-tui", "typebox"].map((name) => [name, "*"])),
};
const files = ["package.json", "README.md", "src/extension.ts", "src/core/types.ts"];

test("qualification admits only the declared current Pi host, not a historical host matrix", () => {
	const gate: unknown = Reflect.get(qualification, "requireCurrentPiHost");
	assert.ok(typeof gate === "function", "qualification must expose the current-host admission gate");
	assert.doesNotThrow(() => gate(MIN_PI_VERSION));
	for (const version of ["1.0.0", "1.3.0", "0.99.9", "99.0.0", "garbage"]) {
		assert.throws(() => gate(version), /current Pi host/i);
	}
});

test("qualification environment strips shell credentials, extension switches and unsafe TLS", () => {
	const env = qualificationEnv({ PATH: "bin", SystemRoot: "Windows", OPENAI_API_KEY: "secret", HOME: "/operator", NODE_OPTIONS: "--import untrusted", PI_PERSONA_DISABLE: "1", NODE_TLS_REJECT_UNAUTHORIZED: "0" }, "/profile");
	assert.equal(env.PATH, "bin");
	assert.equal(env.OPENAI_API_KEY, undefined);
	assert.equal(env.NODE_OPTIONS, undefined);
	assert.equal(env.PI_PERSONA_DISABLE, undefined);
	assert.equal(env.NODE_TLS_REJECT_UNAUTHORIZED, "1");
	assert.equal(env.PI_AGENT_DIR, "/profile");
	assert.equal(env.HOME, "/profile");
	assert.equal(env.PI_OFFLINE, "1");
});

test("package extraction removes only the stale candidate package from a copied host", async () => {
	const dir = await mkdtemp(join(tmpdir(), "package-qualification-extract-"));
	const hostRoot = join(dir, "host");
	const candidate = join(hostRoot, "node_modules", "@aeondave", "pi-persona");
	const obsolete = join(candidate, "obsolete-candidate-file.js");
	const hostPackage = join(hostRoot, "node_modules", "@earendil-works", "pi-coding-agent", "package.json");
	try {
		await mkdir(candidate, { recursive: true });
		await mkdir(join(hostRoot, "node_modules", "@earendil-works", "pi-coding-agent"), { recursive: true });
		await writeFile(obsolete, "stale candidate");
		await writeFile(hostPackage, "host package remains");

		assert.equal(await resetCandidatePackage(hostRoot), candidate);
		await assert.rejects(readFile(obsolete), { code: "ENOENT" });
		assert.equal(await readFile(hostPackage, "utf8"), "host package remains");
		await writeFile(join(candidate, "fresh-package-file.js"), "fresh candidate");
	} finally { await rm(dir, { recursive: true, force: true }); }
});

test("peer containment rejects prefix siblings and outside paths", async () => {
	const dir = await mkdtemp(join(tmpdir(), "package-qualification-containment-"));
	const hostRoot = join(dir, "host");
	const inside = join(hostRoot, "node_modules", "peer", "package.json");
	const prefixSibling = join(dir, "host-elsewhere", "package.json");
	const outside = join(dir, "outside", "package.json");
	try {
		for (const file of [inside, prefixSibling, outside]) {
			await mkdir(dirname(file), { recursive: true });
			await writeFile(file, "{}");
		}
		assert.equal(await isRealPathWithin(hostRoot, inside), true);
		assert.equal(await isRealPathWithin(hostRoot, prefixSibling), false);
		assert.equal(await isRealPathWithin(hostRoot, outside), false);
	} finally { await rm(dir, { recursive: true, force: true }); }
});

test("package inspection accepts only declared resources and host-owned wildcard peers", () => {
	assert.deepEqual(inspectPackage(manifest, files).extensions, ["src/extension.ts"]);
	for (const path of ["test/surprise.ts", "node_modules/typebox/index.js", "docs/plans/draft.md", "../outside", "src/../../outside"])
		assert.throws(() => inspectPackage(manifest, [...files, path]), /allowlist|unsafe|bundled/i, path);
	assert.throws(() => inspectPackage({ ...manifest, dependencies: { typebox: "*" } }, files), /host.*depend/i);
	assert.throws(() => inspectPackage({ ...manifest, peerDependencies: { ...manifest.peerDependencies, typebox: "^1" } }, files), /wildcard/i);
	assert.throws(() => inspectPackage(manifest, files.filter((path) => path !== "src/extension.ts")), /missing.*extension/i);
});

test("process boundary captures failures and enforces a wall deadline", async () => {
	const ok = await runQualificationProcess(process.execPath, ["-e", "console.log('receipt'); process.exitCode=3"], { timeoutMs: 1000 });
	assert.equal(ok.code, 3);
	assert.match(ok.stdout, /receipt/);
	await assert.rejects(runQualificationProcess(process.execPath, ["-e", "setInterval(()=>{},1000)"], { timeoutMs: 100 }), /deadline/i);
	await assert.rejects(runQualificationProcess("package-qualification-nonexistent-command", [], { timeoutMs: 1000 }), /ENOENT/);
});

test("trusted faux provider ignores clock metadata without replaying an earlier tool call", async () => {
	const dir = await mkdtemp(join(tmpdir(), "package-qualification-provider-"));
	const previous = process.env.PACKAGE_QUALIFICATION_RECEIPTS;
	try {
		process.env.PACKAGE_QUALIFICATION_RECEIPTS = join(dir, "receipts.jsonl");
		const fixture = await import(new URL("../fixtures/package-qualification-provider.mjs", import.meta.url).href);
		let provider: any;
		fixture.default({ registerProvider: (value: unknown) => { provider = value; }, on() {}, registerCommand() {} });
		const user = { role: "user", content: [{ type: "text", text: "PACKAGE:complete" }] };
		const clock = { role: "user", content: [{ type: "text", text: "Current clock: metadata" }] };
		const model = provider.getModels()[0];
		const result = await provider.streamSimple(model, { messages: [user, clock] }, {}).result();
		assert.equal(result.content[0].name, "delegate");
		assert.equal(result.content[0].arguments.task, "PACKAGE_WORK:complete");
		const ack = await provider.streamSimple(model, { messages: [user, clock, result, { role: "toolResult", toolName: "delegate", content: [{ type: "text", text: "receipt" }] }, clock] }, {}).result();
		assert.equal(ack.content[0].text, "PACKAGE_SUPERVISOR_ACK");
	} finally {
		if (previous === undefined) delete process.env.PACKAGE_QUALIFICATION_RECEIPTS;
		else process.env.PACKAGE_QUALIFICATION_RECEIPTS = previous;
		await rm(dir, { recursive: true, force: true });
	}
});

test("network preloader blocks fetch and direct sockets before a provider can send", async () => {
	const dir = await mkdtemp(join(tmpdir(), "package-qualification-tripwire-"));
	const file = join(dir, "receipts.jsonl");
	try {
		await writeFile(file, "");
		const preloader = new URL("../fixtures/package-qualification-tripwire.mjs", import.meta.url).href;
		const result = await runQualificationProcess(process.execPath, ["--import", preloader, "--input-type=module", "-e", "import net from 'node:net'; try { await fetch('https://example.invalid'); } catch {} try { net.connect(443, 'example.invalid'); } catch {}"], { timeoutMs: 2000, env: { ...qualificationEnv(process.env, dir), PACKAGE_QUALIFICATION_RECEIPTS: file } });
		assert.equal(result.code, 0, result.stderr);
		const { readFile } = await import("node:fs/promises");
		const rows = (await readFile(file, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
		assert.equal(rows[0].event, "network_tripwire_armed");
		assert.deepEqual(rows.filter((row) => row.event === "network_blocked").map((row) => row.transport), ["fetch", "socket"]);
	} finally { await rm(dir, { recursive: true, force: true }); }
});

test("receipt waits handle both existing receipts and event-driven appends", async () => {
	const dir = await mkdtemp(join(tmpdir(), "package-qualification-unit-"));
	const file = join(dir, "receipts.jsonl");
	try {
		await writeFile(file, '{"event":"existing"}\n');
		assert.equal((await waitForReceipt(file, (row) => row.event === "existing", 1000)).event, "existing");
		const pending = waitForReceipt(file, (row) => row.event === "appended", 1000);
		await appendFile(file, '{"event":"appended"}\n');
		assert.equal((await pending).event, "appended");
		await assert.rejects(waitForReceipt(file, () => false, 20), /receipt.*deadline/i);
		await appendFile(file, 'not-json\n');
		await assert.rejects(waitForReceipt(file, () => false, 1000), /JSON/);
	} finally { await rm(dir, { recursive: true, force: true }); }
});
