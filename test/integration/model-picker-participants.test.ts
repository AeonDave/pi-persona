/**
 * The participant-aware model picker + the main-only strategy recovery wiring.
 *
 * Scope: an orchestrated run's participants are its roster members AND every auxiliary actor a
 * strategy declares (an arbiter, a synthesiser, a critic), plus one participant per lens role of a
 * single agent. The picker may ask about each of them once per session, never about anyone whose
 * model is already assigned (inline, saved, or the agent's own frontmatter), and never at all
 * without a UI. Strategy/flow engines are built WITHOUT the provider-reroute decorator, so the
 * SDK's main-model recovery is the one and only switch.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import piPersona, { type EngineFactories } from "../../src/extension.ts";
import { seedDefaults } from "../../src/core/seed.ts";
import { participantKey } from "../../src/persona/model-participants.ts";
import { emptyUsage } from "../../src/engine/stream.ts";
import type { AgentRunSpec, StrategyEngine } from "../../src/orchestration/sdk.ts";
import { tempDir } from "../setup/temp-dir.ts";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const MODELS = [
	{ provider: "alpha", id: "one" },
	{ provider: "beta", id: "two" },
];

// biome-ignore lint: a deliberately loose mock of the Pi ExtensionAPI surface
type AnyFn = (...args: any[]) => any;

function makeMockPi() {
	const hooks: Record<string, AnyFn> = {};
	const tools: Record<string, unknown> = {};
	const commands: Record<string, { handler: AnyFn }> = {};
	const pi = {
		on: (ev: string, h: AnyFn) => { hooks[ev] = h; },
		registerTool: (def: { name: string }) => { tools[def.name] = def; },
		registerMessageRenderer: () => {},
		registerEntryRenderer: () => {},
		appendEntry: () => {},
		registerCommand: (name: string, def: { handler: AnyFn }) => { commands[name] = def; },
		registerShortcut: () => {},
		registerFlag: () => {},
		getFlag: () => false,
		sendMessage: () => {},
		getAllTools: () => Object.keys(tools).map((n) => ({ name: n })),
		getActiveTools: () => Object.keys(tools),
		setActiveTools: () => {},
		getThinkingLevel: () => "medium",
		setThinkingLevel: () => {},
		setModel: async () => true,
	};
	return {
		pi: pi as unknown as ExtensionAPI,
		tool: (name: string) => tools[name],
		fire: (ev: string, ...args: unknown[]) => {
			const h = hooks[ev];
			if (!h) throw new Error(`no hook: ${ev}`);
			return h(...args);
		},
		cmd: (name: string, args: string, ctx: unknown) => {
			const c = commands[name];
			if (!c) throw new Error(`no command: ${name}`);
			return c.handler(args, ctx);
		},
	};
}

function makeCtx(cwd: string, opts: { hasUI?: boolean; onSelect?: AnyFn } = {}) {
	const notes: string[] = [];
	const ctx = {
		cwd,
		hasUI: opts.hasUI ?? false,
		mode: opts.hasUI ? "rpc" : "print",
		model: opts.hasUI ? { provider: "alpha", id: "one" } : undefined,
		modelRegistry: { getAll: () => MODELS, getAvailable: () => MODELS },
		isIdle: () => true,
		hasPendingMessages: () => false,
		ui: {
			setStatus: () => {},
			notify: (msg: string) => { notes.push(msg); },
			select: async (title: string, options: string[]) => (opts.onSelect ? opts.onSelect(title, options) : options[0]),
			custom: async () => undefined,
		},
	};
	return { ctx, notes };
}

/** A project cwd with an ad-hoc team, so a run's roster is under the test's control. */
function projectWith(teamYaml: string, agents: Record<string, string> = {}): string {
	const cwd = tempDir("pi-persona-participants-");
	fs.mkdirSync(path.join(cwd, ".pi", "agents"), { recursive: true });
	fs.writeFileSync(path.join(cwd, ".pi", "teams.yaml"), teamYaml);
	for (const [name, body] of Object.entries(agents)) {
		fs.writeFileSync(path.join(cwd, ".pi", "agents", `${name}.md`), body);
	}
	return cwd;
}

const personaOf = (body: string): string => `---\nname: judge-host\npersona: true\ncouncil:\n  strategy: fanout\n---\n${body}`;

interface Harness {
	m: ReturnType<typeof makeMockPi>;
	titles: string[];
	runs: AgentRunSpec[];
	select: AnyFn;
	ctx: unknown;
	notes: string[];
	savedModels: () => Record<string, string>;
}

/** Boot one extension against a seeded temp agent dir, with a fake engine that records every leg. */
async function boot(opts: {
	cwd: string;
	hasUI?: boolean;
	persona: string;
	select?: AnyFn;
	engines?: EngineFactories;
}): Promise<Harness> {
	const fresh = tempDir("pi-persona-participant-userdir-");
	seedDefaults(REPO_ROOT, path.join(fresh, "persona"), true);
	process.env.PI_AGENT_DIR = fresh;
	const m = makeMockPi();
	const runs: AgentRunSpec[] = [];
	const engines: EngineFactories = opts.engines ?? {
		makeEngine: () => fakeEngine(runs),
		makeInProcessEngine: () => fakeEngine(runs),
	};
	piPersona(m.pi, { engineFactories: engines });
	const titles: string[] = [];
	const select: AnyFn = async (title: string, options: string[]) => {
		titles.push(title);
		return opts.select ? opts.select(title, options) : options[0];
	};
	const { ctx, notes } = makeCtx(opts.cwd, { hasUI: opts.hasUI ?? true, ...(opts.hasUI === false ? {} : { onSelect: select }) });
	const personaFile = path.join(fresh, "persona", "agents", "judge-host.md");
	fs.mkdirSync(path.dirname(personaFile), { recursive: true });
	fs.writeFileSync(personaFile, opts.persona);
	await m.fire("session_start", undefined, ctx);
	await m.cmd("persona", "judge-host", ctx);
	return {
		m,
		titles,
		runs,
		select,
		ctx,
		notes,
		savedModels: () => {
			const file = path.join(fresh, "persona", "config.json");
			return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8"))["judge-host"]?.models ?? {} : {};
		},
	};
}

function fakeEngine(runs: AgentRunSpec[]): StrategyEngine {
	return {
		run: async (spec: AgentRunSpec) => {
			runs.push(spec);
			// A cheap, deterministic success: these tests are about routing and prompts, not output.
			return { agent: spec.agent, output: `out:${spec.agent}`, usage: emptyUsage(), ok: true };
		},
	};
}

// ── auxiliary actors ──────────────────────────────────────────────────────────────────────

test("an arbiter declared by an agent-typed strategy param is a participant and gets its own prompt", async () => {
	const cwd = projectWith("panel: [operator, verifier]\n");
	const h = await boot({ cwd, persona: personaOf("Host.") });
	{
		const council = h.m.tool("council") as { execute: AnyFn };
		await council.execute("arbiter-1", { question: "decide", strategy: "judge", roster: "panel", params: { judge: "casper" } }, undefined, undefined, h.ctx);

		const asked = h.titles.filter((t) => t.includes('"casper"'));
		assert.equal(asked.length, 1, `the arbiter must be offered a model, asked: ${JSON.stringify(h.titles)}`);
		// The panel members are asked too, so the arbiter is not a special case bolted on the side.
		for (const panel of ["operator", "verifier"]) {
			assert.ok(h.titles.some((t) => t.includes(`"${panel}"`)), `${panel} must be asked: ${JSON.stringify(h.titles)}`);
		}
		assert.deepEqual(Object.keys(h.savedModels()).sort(), ["casper", "operator", "verifier"]);
		// The arbiter really ran — the picker was not asking about a phantom participant.
		assert.ok(h.runs.some((r) => r.agent === "casper"), "the judge strategy spawned the arbiter");
	}
});

// ── roles ─────────────────────────────────────────────────────────────────────────────────

test("each lens role of one agent is its own participant, saved under a stable key that hides the role prose", async () => {
	const SECURITY = "Focus ONLY on the SECURITY lens: unsafe input flows";
	const PERF = "Focus ONLY on the PERFORMANCE lens: hot paths";
	const cwd = projectWith(`lenses:\n  - { agent: reviewer, role: "${SECURITY}" }\n  - { agent: reviewer, role: "${PERF}" }\n`);
	const h = await boot({ cwd, persona: personaOf("Host.") });
	{
		const council = h.m.tool("council") as { execute: AnyFn };
		await council.execute("roles-1", { question: "review", strategy: "fanout", roster: "lenses" }, undefined, undefined, h.ctx);

		assert.equal(h.titles.length, 2, `both lenses asked, got: ${JSON.stringify(h.titles)}`);
		assert.ok(h.titles.some((t) => t.includes("reviewer · SECURITY")), h.titles.join(" | "));
		assert.ok(h.titles.some((t) => t.includes("reviewer · PERFORMANCE")), h.titles.join(" | "));

		const saved = h.savedModels();
		assert.deepEqual(Object.keys(saved).sort(), [participantKey("reviewer", PERF), participantKey("reviewer", SECURITY)].sort());
		for (const key of Object.keys(saved)) {
			assert.equal(key.includes("lens"), false, `a role prompt must never be persisted as a key: ${key}`);
		}

		// A SECOND run in the same session asks nothing: every participant is assigned now.
		const before = h.titles.length;
		await council.execute("roles-2", { question: "review again", strategy: "fanout", roster: "lenses" }, undefined, undefined, h.ctx);
		assert.equal(h.titles.length, before, "an assigned participant is never re-asked");
		// …and the saved role key is what the legs actually ran on.
		const byRole = h.runs.filter((r) => r.agent === "reviewer");
		assert.ok(byRole.length >= 2);
		assert.deepEqual(byRole.map((r) => r.role), [SECURITY, PERF, SECURITY, PERF]);
	}
});

// ── rosters, saved choices, dismissals, headless ───────────────────────────────────────────

test("a NEW roster's members are prompted once while an already-assigned roster is left alone", async () => {
	const cwd = projectWith("first: [operator]\nsecond: [scout]\n");
	const h = await boot({ cwd, persona: personaOf("Host.") });
	{
		const council = h.m.tool("council") as { execute: AnyFn };
		await council.execute("r1", { question: "one", strategy: "fanout", roster: "first" }, undefined, undefined, h.ctx);
		assert.deepEqual(h.titles.map((t) => t.match(/Model for "([^"]+)"/)?.[1]), ["operator"]);

		await council.execute("r2", { question: "two", strategy: "fanout", roster: "first" }, undefined, undefined, h.ctx);
		assert.equal(h.titles.length, 1, "the assigned roster is silent on the second run");

		await council.execute("r3", { question: "three", strategy: "fanout", roster: "second" }, undefined, undefined, h.ctx);
		assert.deepEqual(h.titles.map((t) => t.match(/Model for "([^"]+)"/)?.[1]), ["operator", "scout"], "a new actor is asked the first time it appears");
		assert.deepEqual(Object.keys(h.savedModels()).sort(), ["operator", "scout"]);
	}
});

test("a dismissed picker is never reopened for the same participant in the same session", async () => {
	const cwd = projectWith("pairless: [operator, verifier]\n");
	const h = await boot({ cwd, persona: personaOf("Host."), select: () => undefined });
	{
		const council = h.m.tool("council") as { execute: AnyFn };
		await council.execute("d1", { question: "one", strategy: "fanout", roster: "pairless" }, undefined, undefined, h.ctx);
		const first = h.titles.length;
		assert.equal(first, 2, "both members are offered a choice");
		await council.execute("d2", { question: "two", strategy: "fanout", roster: "pairless" }, undefined, undefined, h.ctx);
		assert.equal(h.titles.length, first, "a dismissal is not a re-prompt; the run falls back to the session model");
		assert.deepEqual(h.savedModels(), {}, "nothing was chosen, so nothing was written");
		// The dismissed legs still ran, on the session default.
		assert.deepEqual(h.runs.map((r) => r.agent).sort(), ["operator", "operator", "verifier", "verifier"]);
	}
});

test("headless never opens a model dialog", async () => {
	const cwd = projectWith("duo: [operator, verifier]\n");
	const h = await boot({ cwd, persona: personaOf("Host."), hasUI: false });
	{
		const council = h.m.tool("council") as { execute: AnyFn };
		await council.execute("headless-1", { question: "one", strategy: "fanout", roster: "duo" }, undefined, undefined, h.ctx);
		assert.deepEqual(h.titles, [], "a headless run must not ask anything");
		assert.deepEqual(h.savedModels(), {}, "and must not invent assignments");
		assert.equal(h.runs.length, 2, "the run still happens, on the runtime default");
	}
});

test("an agent's own frontmatter model is never overridden by the picker", async () => {
	const cwd = projectWith(
		"declared: [pinned]\n",
		{ pinned: "---\nname: pinned\nmodel: alpha/one\n---\nPinned by its own file.\n" },
	);
	const h = await boot({ cwd, persona: personaOf("Host.") });
	{
		const council = h.m.tool("council") as { execute: AnyFn };
		await council.execute("front-1", { question: "one", strategy: "fanout", roster: "declared" }, undefined, undefined, h.ctx);
		assert.deepEqual(h.titles, [], `a declared model needs no prompt, got: ${JSON.stringify(h.titles)}`);
		assert.deepEqual(h.savedModels(), {}, "the config defaults are left exactly as they were");
		assert.deepEqual(h.runs.map((r) => r.agent), ["pinned"]);
	}
});

// ── main-only recovery ────────────────────────────────────────────────────────────────────

test("a strategy engine is built WITHOUT the provider-reroute decorator (the SDK's main recovery is the only switch)", async () => {
	const cwd = projectWith("duo: [operator, verifier]\n");
	const attempts: string[] = [];
	const failing: StrategyEngine = {
		run: async (spec: AgentRunSpec) => {
			attempts.push(`${spec.agent}@${spec.model ?? "(resolved-by-engine)"}`);
			// A leg pinned to a model that is NOT the main one, failing for a model reason: the SDK
			// may legitimately re-run it on the session model — and on nothing else.
			const used = spec.model ?? "beta/two";
			return { agent: spec.agent, output: "", usage: emptyUsage(), ok: false, error: "503 upstream", failureKind: "provider", modelUsed: used };
		},
	};
	const h = await boot({
		cwd,
		persona: personaOf("Host."),
		engines: { makeEngine: () => failing, makeInProcessEngine: () => failing },
	});
	{
		const council = h.m.tool("council") as { execute: AnyFn };
		const result = await council.execute("nofallback-1", { question: "one", strategy: "fanout", roster: "duo" }, undefined, undefined, h.ctx);
		const legs = attempts.filter((a) => a.endsWith("@(resolved-by-engine)"));
		assert.equal(legs.length, 2, `one first attempt per leg, got ${JSON.stringify(attempts)}`);
		const reroutes = attempts.filter((a) => !a.endsWith("@(resolved-by-engine)"));
		assert.equal(reroutes.length, 2, `each broken leg is re-run once, got ${JSON.stringify(attempts)}`);
		assert.deepEqual(
			reroutes.map((a) => a.split("@")[1]),
			["alpha/one", "alpha/one"],
			`every recovery landed on the MAIN model (alpha/one), never on another provider: ${JSON.stringify(reroutes)}`,
		);
		assert.equal(result.isError, true, "the failing council still settles with an honest failure");
	}
});

// ── ephemeral inline members ──────────────────────────────────────────────────────────────

test("inline members win the named roster for the picker, and nothing static is mutated", async () => {
	const cwd = projectWith("team: [operator]\n");
	const h = await boot({ cwd, persona: personaOf("Host.") });
	{
		const council = h.m.tool("council") as { execute: AnyFn };
		await council.execute(
			"inline-1",
			{ question: "one", strategy: "fanout", roster: "team", members: [{ agent: "scout" }, { agent: "reviewer", role: "SECURITY lens" }] },
			undefined,
			undefined,
			h.ctx,
		);
		const asked = h.titles.map((t) => t.match(/Model for "([^"]+)"/)?.[1]);
		assert.deepEqual(asked, ["scout", "reviewer · SECURITY"], `the INLINE panel is the panel, got ${JSON.stringify(asked)}`);
		assert.deepEqual(h.runs.map((r) => r.agent), ["scout", "reviewer"], "and it is what ran");

		// The named team is untouched for the next call.
		await council.execute("inline-2", { question: "two", strategy: "fanout", roster: "team" }, undefined, undefined, h.ctx);
		assert.deepEqual(h.runs.slice(2).map((r) => r.agent), ["operator"], "the static roster is unchanged");
	}
});

// ── untrusted chrome reaching the UI ──────────────────────────────────────────────────────

test("a role prompt carrying terminal escapes or newlines cannot repaint the picker or the tree", async () => {
	// A role is free prose a team file (or a caller) supplies; it reaches a TUI title and a tree
	// label. Unfiltered it could repaint the screen or forge a chrome row.
	const nasty = "\u001b[31mSECURITY\u001b[0m lens\nsecond line";
	// Passed INLINE: a control character has no legal YAML encoding, and a role's whole point is
	// that it is arbitrary caller prose on its way to a TUI title.
	const h = await boot({ cwd: projectWith("unused: []\n"), persona: personaOf("Host.") });
	{
		const council = h.m.tool("council") as { execute: AnyFn };
		await council.execute("nasty-1", { question: "one", strategy: "fanout", members: [{ agent: "reviewer", role: nasty }] }, undefined, undefined, h.ctx);

		assert.equal(h.titles.length, 1, `the lens is still offered a choice: ${JSON.stringify(h.titles)}`);
		const title = h.titles[0] ?? "";
		assert.equal(title.includes("\u001b"), false, `the picker title must be escape-free: ${JSON.stringify(title)}`);
		assert.equal(title.includes("\n"), false, `the picker title must be one line: ${JSON.stringify(title)}`);
		assert.match(title, /reviewer · SECURITY/, "the lens still reads as a lens, bounded to one line");
		// …and the assignment is filed under the digest of the RAW role, so sanitising the display
		// can never fork a participant into two identities.
		assert.deepEqual(Object.keys(h.savedModels()), [participantKey("reviewer", nasty)]);
	}
});

test("a model-fallback toast is sanitised and can never throw into the run", async () => {
	const cwd = projectWith("duo: [operator]\n");
	const attempts: string[] = [];
	const failing: StrategyEngine = {
		run: async (spec: AgentRunSpec) => {
			attempts.push(spec.agent);
			// A hostile-shaped failure report: agent name and model both carry escapes/newlines.
			return {
				agent: spec.agent,
				output: "",
				usage: emptyUsage(),
				ok: false,
				error: "boom",
				failureKind: "provider",
				modelUsed: "\u001b[2Kb/two\nnext",
			};
		},
	};
	const h = await boot({
		cwd,
		persona: personaOf("Host."),
		engines: { makeEngine: () => failing, makeInProcessEngine: () => failing },
	});
	{
		const council = h.m.tool("council") as { execute: AnyFn };
		const result = await council.execute("toast-1", { question: "one", strategy: "fanout", roster: "duo" }, undefined, undefined, h.ctx);
		assert.ok(attempts.length >= 1, `the leg ran: ${JSON.stringify(attempts)} notes=${JSON.stringify(h.notes)}`);
		const toasts = h.notes.filter((n) => n.includes("re-running on"));
		assert.equal(toasts.length, 1, `one recovery toast for the one broken leg: attempts=${JSON.stringify(attempts)} notes=${JSON.stringify(h.notes)}`);
		assert.equal(toasts[0]?.includes("\u001b"), false, `toast must be escape-free: ${JSON.stringify(toasts)}`);
		assert.equal(toasts[0]?.includes("\n"), false, `toast must be one line: ${JSON.stringify(toasts)}`);
		assert.match(toasts[0] ?? "", /alpha\/one/);
		// The cosmetic callback must not have corrupted the run's own report.
		assert.equal(result.isError, true);
		assert.match(String(result.content?.[0]?.text ?? ""), /untrusted data/i);
	}
});

// silence the unused-import lint for a fixture-only helper
void os;