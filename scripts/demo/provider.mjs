/**
 * Scripted model provider for README demo recordings. Loaded as a Pi extension by `record.mjs`.
 *
 * Every response comes from the scenario named by `DEMO_SCENARIO`; nothing reaches a network or a
 * real model. The scenario decides from the transcript alone, so supervisor and worker sessions
 * (which share this process under the in-process engine) need no shared state.
 *
 * `DEMO_DEBUG=<file>` appends one line per model request (model, task, message outline): the way to
 * see what a session's transcript looks like while writing a scenario.
 */
import { appendFileSync } from "node:fs";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxThinking, fauxToolCall } from "@earendil-works/pi-ai";

const scenario = await import(process.env.DEMO_SCENARIO);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const INJECTED = /^(?:\[pi-persona\]|Current clock:)/;

function text(message) {
	if (!message) return "";
	if (typeof message.content === "string") return message.content;
	return (message.content ?? []).map((block) => block.text ?? block.thinking ?? "").join("\n");
}

export default function (pi) {
	const faux = fauxProvider({
		provider: "demo",
		tokensPerSecond: scenario.tokensPerSecond ?? 90,
		models: (scenario.models ?? ["opus-5", "sonnet-5", "haiku-5"]).map((id) => ({ id, reasoning: true, contextWindow: 200_000 })),
	});
	let sequence = 0;
	const stream = (model, context, options) => {
		// Per-turn context the extension appends (clock, naming bootstrap) is not part of the dialogue.
		const messages = (context.messages ?? []).filter((message) => message.role !== "system" && !(message.role === "user" && INJECTED.test(text(message))));
		const calls = messages.flatMap((message) => message.role === "assistant" && Array.isArray(message.content) ? message.content.filter((block) => block.type === "toolCall") : []);
		const users = messages.filter((message) => message.role === "user");
		const view = {
			/** The session's whole system prompt (Pi sends it as a sectioned `system` message). */
			system: JSON.stringify((context.messages ?? []).filter((message) => message.role === "system")),
			messages,
			/** First user message: a worker's task, or the operator's opening prompt. */
			task: text(users[0]),
			last: messages.at(-1),
			/** Assistant turns already produced in this session. */
			turn: messages.filter((message) => message.role === "assistant").length,
			/** Name of the tool whose result is the newest message, if any. */
			tool: messages.at(-1)?.role === "toolResult" ? messages.at(-1).toolName : undefined,
			/** Whether this session already called a tool. */
			called: (name) => calls.some((block) => block.name === name),
			/** Whether any message so far matches. */
			seen: (pattern) => messages.some((message) => pattern.test(text(message))),
		};
		if (process.env.DEMO_DEBUG) appendFileSync(process.env.DEMO_DEBUG, JSON.stringify({ model: model.id, task: view.task.slice(0, 80), roles: messages.map((message) => `${message.role}:${message.toolName ?? ""}:${text(message).slice(0, 60)}`) }) + "\n");
		const id = () => `demo-${++sequence}-${Math.random().toString(36).slice(2, 8)}`;
		const helpers = {
			sleep,
			say: (content) => fauxAssistantMessage(content),
			think: fauxThinking,
			text: fauxText,
			call: (name, args) => fauxToolCall(name, args, { id: id() }),
			act: (...blocks) => fauxAssistantMessage(blocks, { stopReason: "toolUse" }),
		};
		faux.appendResponses([async () => {
			const response = await scenario.respond(view, helpers);
			return response ?? fauxAssistantMessage("Done.");
		}]);
		return faux.provider.streamSimple(model, context, options);
	};
	pi.registerProvider({ ...faux.provider, stream, streamSimple: stream });
}
