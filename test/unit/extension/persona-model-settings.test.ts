import { test } from "node:test";
import assert from "node:assert/strict";

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { openPersonaModelSettings, type PersonaModelSettingsDeps } from "../../../src/extension/persona-model-settings.ts";
import type { ModelParticipant } from "../../../src/persona/model-participants.ts";
import { ModelPicker } from "../../../src/ui/model-picker.ts";

interface SelectRequest {
	title: string;
	options: string[];
}

interface MockOptions {
	mode?: "tui" | "rpc";
	select?: (request: SelectRequest) => string | undefined;
	customPick?: string | undefined;
	available?: Array<{ provider: string; id: string }>;
	refresh?: (options: { signal?: AbortSignal }) => Promise<{ aborted: boolean; errors: Map<string, Error> }>;
	signal?: AbortSignal;
}

function context(options: MockOptions = {}) {
	const requests: SelectRequest[] = [];
	const notifications: Array<{ message: string; level: string }> = [];
	const customOptions: Array<{ overlay?: boolean }> = [];
	let availableReads = 0;
	let refreshCalls = 0;
	const ctx = {
		hasUI: true,
		mode: options.mode ?? "rpc",
		model: { provider: "session-provider", id: "session-model" },
		signal: options.signal,
		modelRegistry: {
			getAvailable: () => {
				availableReads++;
				return options.available ?? [{ provider: "provider", id: "model" }];
			},
			refresh: async (refreshOptions: { signal?: AbortSignal }) => {
				refreshCalls++;
				return options.refresh?.(refreshOptions) ?? { aborted: false, errors: new Map() };
			},
		},
		ui: {
			select: async (title: string, choices: string[]) => {
				const request = { title, options: choices };
				requests.push(request);
				return options.select?.(request);
			},
			custom: async (factory: unknown, pickerOptions: { overlay?: boolean }) => {
				customOptions.push(pickerOptions);
				if (options.mode === "tui") {
					const render = factory as (tui: unknown, theme: unknown, keybindings: unknown, done: (value: string | undefined) => void) => unknown;
					const picker = render(
						{ requestRender() {} },
						{ fg: (_color: string, text: string) => text, bold: (text: string) => text },
						undefined,
						() => {},
					);
					assert.ok(picker instanceof ModelPicker, "TUI model selection uses the focusable model picker");
				}
				return options.customPick;
			},
			notify: (message: string, level: string) => notifications.push({ message, level }),
		},
	} as unknown as ExtensionContext;
	return {
		ctx,
		requests,
		notifications,
		customOptions,
		get availableReads() { return availableReads; },
		get refreshCalls() { return refreshCalls; },
	};
}

function participant(overrides: Partial<ModelParticipant> = {}): ModelParticipant {
	return {
		agent: "reviewer",
		role: "Focus on access control and unsafe flows",
		key: "reviewer#0123456789abcdef0123456789abcdef",
		label: "reviewer · SECURITY",
		origin: "roster",
		model: "provider/shared-model",
		source: "assignment",
		assigned: true,
		...overrides,
	};
}

function deps(overrides: Partial<PersonaModelSettingsDeps> = {}) {
	const writes: Array<{ owner: string; patch: Record<string, string | null> }> = [];
	const base: PersonaModelSettingsDeps = {
		owners: () => [
			{ name: "active", label: "Active" },
			{ name: "other", label: "Other" },
		],
		activeOwner: () => "active",
		profiles: () => [{ name: "judge", label: "Judge profile" }],
		participants: () => [participant()],
		saved: () => ({ "reviewer": "provider/shared-model" }),
		write: (owner, patch) => writes.push({ owner, patch }),
		...overrides,
	};
	return { value: base, writes };
}

function chooseByTitle(selectors: Record<string, (request: SelectRequest) => string | undefined>) {
	return ({ title, options }: SelectRequest): string | undefined => {
		for (const [prefix, pick] of Object.entries(selectors)) {
			if (title.startsWith(prefix)) return pick({ title, options });
		}
		return undefined;
	};
}

function visitParticipantThenDone(match: (option: string) => boolean) {
	let visited = false;
	return ({ options }: SelectRequest): string | undefined => {
		if (!visited) {
			visited = true;
			return options.find(match);
		}
		return options.find((item) => item === "Done");
	};
}

function chooseActionThenDone(match: (option: string) => boolean) {
	let visited = false;
	return ({ options }: SelectRequest): string | undefined => {
		if (!visited) {
			visited = true;
			return options.find(match);
		}
		return options.find((item) => item === "Done");
	};
}

test("requires an explicit owner and edits that saved profile without activating it", async () => {
	const ui = context({ select: chooseByTitle({
		"Persona model owner": ({ options }) => options.find((item) => item.includes("other")),
		"Council profile": ({ options }) => options.find((item) => item.includes("Judge profile")),
		"Model settings": visitParticipantThenDone((item) => item.includes("reviewer")),
		"Edit participant": ({ options }) => options.find((item) => item.includes("Set or change")),
		"Model for": ({ options }) => options.find((item) => item === "provider/model"),
	}) });
	const d = deps({
		owners: () => [{ name: "other", label: "Other" }, { name: "active", label: "Active" }],
		saved: () => ({ reviewer: "provider/shared-model" }),
	});

	await openPersonaModelSettings(ui.ctx, d.value);

	assert.equal(ui.requests[0]?.title, "Persona model owner", "the owner is always explicitly chosen, even when one is active");
	assert.ok(ui.requests[0]?.options[0]?.includes("active"), "the active owner is offered first without being selected implicitly");
	assert.ok(ui.requests[0]?.options.some((item) => item.includes("active")), "active owner remains offered first/marked, not silently selected");
	assert.equal(d.writes.length, 1);
	assert.equal(d.writes[0]?.owner, "other", "assignment belongs to the selected owner, not the active persona");
	assert.deepEqual(d.writes[0]?.patch, { "reviewer#0123456789abcdef0123456789abcdef": "provider/model" });
	assert.ok(ui.requests.some((request) => request.title === "Council profile" && request.options.some((item) => item.includes("Current profile"))));
	assert.ok(ui.requests.some((request) => request.options.some((item) => item.includes("shared"))), "row shows effective model/source and shared agent-key fallback");
	assert.equal("activate" in ui.ctx, false, "this command has no persona activation API to call");
});

test("reset stages null only for the participant's own key, not its shared agent fallback", async () => {
	const roleKey = "reviewer#0123456789abcdef0123456789abcdef";
	const ui = context({ select: chooseByTitle({
		"Persona model owner": ({ options }) => options.find((item) => item.includes("active")),
		"Council profile": ({ options }) => options.find((item) => item.includes("Current profile")),
		"Model settings": visitParticipantThenDone((item) => item.includes("reviewer")),
		"Edit participant": ({ options }) => options.find((item) => item.includes("Reset")),
	}) });
	const d = deps({
		participants: () => [participant()],
		saved: () => ({ reviewer: "provider/shared-model", [roleKey]: "provider/role-model" }),
	});

	await openPersonaModelSettings(ui.ctx, d.value);

	assert.deepEqual(d.writes, [{ owner: "active", patch: { [roleKey]: null } }]);
});

test("inline model pins are listed as read-only and never written", async () => {
	const inline = participant({ model: "provider/pinned", source: "inline", assigned: true });
	const ui = context({ select: chooseByTitle({
		"Persona model owner": ({ options }) => options[0],
		"Council profile": ({ options }) => options[0],
		"Model settings": visitParticipantThenDone((item) => item.includes("reviewer")),
		"Edit participant": ({ options }) => options.find((item) => item.includes("Back")),
	}) });
	const d = deps({ participants: () => [inline], saved: () => ({}) });

	await openPersonaModelSettings(ui.ctx, d.value);

	assert.equal(d.writes.length, 0);
	assert.ok(ui.requests.some((request) => request.options.some((item) => item.includes("provider/pinned") && item.includes("inline"))));
	assert.ok(ui.notifications.some((item) => /read.only|inline/i.test(item.message)));
});

test("other saved assignments are shown by safe key and can be explicitly reset", async () => {
	const stale = "old-agent#fedcba9876543210fedcba9876543210";
	const ui = context({ select: chooseByTitle({
		"Persona model owner": ({ options }) => options[0],
		"Council profile": ({ options }) => options[0],
		"Model settings": chooseActionThenDone((item) => item.includes("Manage other saved")),
		"Other saved assignment": ({ options }) => options.find((item) => item.includes("old-agent#fedcba")),
	}) });
	const d = deps({ saved: () => ({ reviewer: "provider/current", [stale]: "provider/old" }) });

	await openPersonaModelSettings(ui.ctx, d.value);

	assert.deepEqual(d.writes, [{ owner: "active", patch: { [stale]: null } }]);
	const otherRequest = ui.requests.find((request) => request.title === "Other saved assignment");
	assert.ok(otherRequest?.options.some((item) => item.includes("old-agent#fedcba")));
	assert.ok(ui.requests.some((request) => request.options.some((item) => item.includes("Manage other saved"))));
});

test("pending reset does not display the removed model as effective", async () => {
	const roleKey = "reviewer#0123456789abcdef0123456789abcdef";
	let settingsMenus = 0;
	let rowAfterReset: string | undefined;
	const ui = context({ select: ({ title, options }) => {
		if (title === "Persona model owner" || title === "Council profile") return options[0];
		if (title.startsWith("Model settings")) {
			settingsMenus++;
			if (settingsMenus === 1) return options.find((item) => item.includes("reviewer"));
			if (settingsMenus === 2) {
				rowAfterReset = options.find((item) => item.includes("reviewer"));
				return options.find((item) => item === "Done");
			}
		}
		if (title.startsWith("Edit participant")) return options.find((item) => item.includes("Reset this participant"));
		return undefined;
	} });
	const d = deps({ saved: () => ({ [roleKey]: "provider/removed-model" }) });

	await openPersonaModelSettings(ui.ctx, d.value);

	assert.ok(rowAfterReset?.includes("resolve lower precedence next run"));
	assert.ok(rowAfterReset?.includes("pending reset"));
	assert.equal(rowAfterReset?.includes("provider/removed-model"), false, "the staged deletion is not presented as the effective assignment");
	assert.deepEqual(d.writes, [{ owner: "active", patch: { [roleKey]: null } }]);
});

test("opening performs no catalog refresh; TUI model choices use ModelPicker without an overlay", async () => {
	const ui = context({ mode: "tui", customPick: "provider/model", select: chooseByTitle({
		"Persona model owner": ({ options }) => options[0],
		"Council profile": ({ options }) => options[0],
		"Model settings": visitParticipantThenDone((item) => item.includes("reviewer")),
		"Edit participant": ({ options }) => options.find((item) => item.includes("Set or change")),
	}), available: [{ provider: "provider", id: "model" }] });
	const d = deps({ saved: () => ({}) });

	await openPersonaModelSettings(ui.ctx, d.value);

	assert.equal(ui.refreshCalls, 0, "provider discovery is never triggered implicitly");
	assert.equal(ui.availableReads, 1, "available local catalog is read only when the model action is chosen");
	assert.equal(ui.customOptions.length, 1);
	assert.equal(ui.customOptions[0]?.overlay, false);
	assert.deepEqual(d.writes[0]?.patch, { "reviewer#0123456789abcdef0123456789abcdef": "provider/model" });
});

test("cancelled model selection discards every staged change", async () => {
	const ui = context({ customPick: undefined, select: chooseByTitle({
		"Persona model owner": ({ options }) => options[0],
		"Council profile": ({ options }) => options[0],
		"Model settings": visitParticipantThenDone((item) => item.includes("reviewer")),
		"Edit participant": ({ options }) => options.find((item) => item.includes("Set or change")),
	}) });
	const d = deps({ saved: () => ({}) });

	await openPersonaModelSettings(ui.ctx, d.value);

	assert.equal(d.writes.length, 0, "cancel means no implicit save");
});

test("canceling the main menu after staging a model discards the draft", async () => {
	let settingsMenus = 0;
	const ui = context({ customPick: "provider/model", available: [{ provider: "provider", id: "model" }], select: ({ title, options }) => {
		if (title === "Persona model owner" || title === "Council profile") return options[0];
		if (title.startsWith("Model settings")) {
			settingsMenus++;
			return settingsMenus === 1 ? options.find((item) => item.includes("reviewer")) : undefined;
		}
		if (title.startsWith("Edit participant")) return options.find((item) => item.includes("Set or change"));
		return undefined;
	} });
	const d = deps({ saved: () => ({}) });

	await openPersonaModelSettings(ui.ctx, d.value);

	assert.equal(d.writes.length, 0, "cancel after staging remains an all-or-nothing discard");
});

test("session changes discard staged edits before persistence", async () => {
	let current = true;
	const ui = context({ select: chooseByTitle({
		"Persona model owner": ({ options }) => options[0],
		"Council profile": ({ options }) => options[0],
		"Model settings": visitParticipantThenDone((item) => item.includes("reviewer")),
		"Edit participant": ({ options }) => options.find((item) => item.includes("Set or change")),
		"Model for": ({ options }) => {
			current = false;
			return options[0];
		},
	}) });
	const d = deps({ saved: () => ({}), isCurrent: () => current });

	await openPersonaModelSettings(ui.ctx, d.value);

	assert.equal(d.writes.length, 0);
	assert.ok(ui.notifications.some((item) => /session|changed/i.test(item.message)));
});

test("explicit refresh uses a bounded signal and preserves assignments on provider errors", async () => {
	const controller = new AbortController();
	let suppliedSignal: AbortSignal | undefined;
	const ui = context({ signal: controller.signal, refresh: async ({ signal }) => {
		suppliedSignal = signal;
		return { aborted: false, errors: new Map([["provider", new Error("offline")]]) };
	}, select: chooseByTitle({
		"Persona model owner": ({ options }) => options[0],
		"Council profile": ({ options }) => options[0],
		"Model settings": chooseActionThenDone((item) => item.includes("Refresh available")),
	}) });
	const d = deps({ saved: () => ({ reviewer: "provider/keep" }) });

	await openPersonaModelSettings(ui.ctx, d.value);

	assert.equal(ui.refreshCalls, 1, "refresh happens only after its explicit menu action");
	assert.ok(suppliedSignal, "refresh receives a deadline/cancellation signal");
	assert.equal(d.writes.length, 0, "provider failure cannot rewrite or clear saved assignments");
	assert.ok(ui.notifications.some((item) => /refresh incomplete|provider/i.test(item.message)));
});

test("explicit refresh uses the catalog owner's adapter through success, partial refresh, or failure", async () => {
	for (const outcome of ["success", "partial", "throw"] as const) {
		let invalidations = 0;
		let settled = false;
		const ui = context({ refresh: async () => {
			settled = true;
			if (outcome === "throw") throw new Error("provider unavailable");
			return { aborted: false, errors: outcome === "partial" ? new Map([["provider", new Error("offline")]]) : new Map() };
		}, select: chooseByTitle({
			"Persona model owner": ({ options }) => options[0],
			"Council profile": ({ options }) => options[0],
			"Model settings": chooseActionThenDone((item) => item.includes("Refresh available")),
		}) });
		const d = deps({ refreshCatalog: async (signal) => {
			assert.ok(signal instanceof AbortSignal);
			try { return await ui.ctx.modelRegistry.refresh({ signal }); }
			finally { assert.ok(settled); invalidations++; }
		} });
		await openPersonaModelSettings(ui.ctx, d.value);
		assert.equal(invalidations, 1, `${outcome} may have changed the host's provider snapshot`);
		assert.equal(ui.refreshCalls, 1, "the owner adapter replaces the default refresh instead of duplicating it");
		assert.equal(d.writes.length, 0);
	}
});

test("explicit refresh failure keeps earlier staged model changes available to Done", async () => {
	let settingsMenus = 0;
	let suppliedSignal: AbortSignal | undefined;
	const ui = context({ available: [{ provider: "provider", id: "chosen" }], refresh: async ({ signal }) => {
		suppliedSignal = signal;
		return { aborted: false, errors: new Map([["provider", new Error("offline")]]) };
	}, select: ({ title, options }) => {
		if (title === "Persona model owner" || title === "Council profile") return options[0];
		if (title.startsWith("Model settings")) {
			settingsMenus++;
			if (settingsMenus === 1) return options.find((item) => item.includes("reviewer"));
			if (settingsMenus === 2) return options.find((item) => item.includes("Refresh available"));
			return options.find((item) => item === "Done");
		}
		if (title.startsWith("Edit participant")) return options.find((item) => item.includes("Set or change"));
		if (title.startsWith("Model for")) return options.find((item) => item === "provider/chosen");
		return undefined;
	} });
	const d = deps({ saved: () => ({}) });

	await openPersonaModelSettings(ui.ctx, d.value);

	assert.ok(suppliedSignal, "explicit refresh receives a bounded cancellation signal");
	assert.equal(ui.refreshCalls, 1);
	assert.deepEqual(d.writes, [{ owner: "active", patch: { "reviewer#0123456789abcdef0123456789abcdef": "provider/chosen" } }]);
	assert.ok(ui.notifications.some((item) => /refresh incomplete|provider/i.test(item.message)));
});

test("participant re-resolution failure after a staged edit returns without writing", async () => {
	let participantReads = 0;
	const ui = context({ available: [{ provider: "provider", id: "chosen" }], select: chooseByTitle({
		"Persona model owner": ({ options }) => options[0],
		"Council profile": ({ options }) => options[0],
		"Model settings": visitParticipantThenDone((item) => item.includes("reviewer")),
		"Edit participant": ({ options }) => options.find((item) => item.includes("Set or change")),
		"Model for": ({ options }) => options.find((item) => item === "provider/chosen"),
	}) });
	const d = deps({
		participants: () => {
			participantReads++;
			if (participantReads > 1) throw new Error(`Malformed council profile: ${"invalid configuration ".repeat(30)}`);
			return [participant()];
		},
		saved: () => ({}),
	});

	await openPersonaModelSettings(ui.ctx, d.value);

	assert.equal(participantReads, 2, "the saved choice was staged before the next participant resolution failed");
	assert.equal(d.writes.length, 0, "participant resolution errors cannot commit staged changes");
	const notification = ui.notifications.find((item) => /participant|configuration|council/i.test(item.message));
	assert.ok(notification, "the resolver failure is explained to the operator");
	assert.ok(notification.message.length <= 260, "configuration error text is bounded for the TUI");
});

test("headless invocation and empty owner list explain the remedy without touching storage", async () => {
	const headless = context();
	Object.defineProperty(headless.ctx, "hasUI", { value: false });
	const noOwners = deps({ owners: () => [] });

	await openPersonaModelSettings(headless.ctx, noOwners.value);

	assert.equal(noOwners.writes.length, 0);
	assert.ok(headless.notifications.some((item) => /interactive|UI/i.test(item.message)));

	const empty = context();
	const emptyDeps = deps({ owners: () => [] });
	await openPersonaModelSettings(empty.ctx, emptyDeps.value);
	assert.equal(emptyDeps.writes.length, 0);
	assert.ok(empty.notifications.some((item) => /seed/i.test(item.message)));
});
