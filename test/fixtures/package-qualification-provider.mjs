// Trusted deterministic provider only. The plugin, host loader and engines remain real.
import { appendFileSync } from "node:fs";
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";

const textOf = (content) => typeof content === "string" ? content : (content ?? []).map((part) => part.text ?? "").join("");
export default function (pi) {
	const leg = process.env.PI_PERSONA_LEG === "1";
	const receipt = (event, extra = {}) => appendFileSync(process.env.PACKAGE_QUALIFICATION_RECEIPTS, `${JSON.stringify({ event, pid: process.pid, leg, ...extra })}\n`);
	receipt("factory", { disabled: process.env.PI_PERSONA_DISABLE, child: process.env.PI_PERSONA_CHILD });
	const faux = fauxProvider({ provider: "package-qualification", models: [{ id: "local", name: "Offline package qualification", contextWindow: 1000000 }], tokenSize: { min: 1000, max: 1000 } });
	const respond = async (context, options) => {
		// Pi converts the extension's clock custom message to a user message after the
		// actual prompt. Ignore that metadata, but never reach past an assistant/tool result
		// and accidentally replay an earlier command on a completion wake.
		const last = context.messages.findLast((message) => message.role === "assistant" || message.role === "toolResult" || (message.role === "user" && /^(?:Task: )?PACKAGE[:_]/.test(textOf(message.content))));
		const text = textOf(last?.content);
		if (last?.role === "user" && /^(?:Task: )?PACKAGE_WORK:/.test(text)) {
			const task = /PACKAGE_WORK:(complete|cancel|shutdown)/.exec(text)?.[1];
			if (!task) throw new Error(`Unknown worker task: ${text}`);
			receipt("worker_started", { task });
			if (task !== "complete") {
				await new Promise((resolve, reject) => {
					const aborted = () => { clearTimeout(deadline); receipt("worker_aborted", { task }); resolve(); };
					const deadline = setTimeout(() => { options?.signal?.removeEventListener("abort", aborted); reject(new Error("Worker abort deadline exceeded")); }, 30000);
					if (options?.signal?.aborted) aborted();
					else options?.signal?.addEventListener("abort", aborted, { once: true });
				});
			}
			return fauxAssistantMessage(`PACKAGE_WORKER_OK:${task}`);
		}
		const command = /^PACKAGE:(complete|cancel|shutdown|stop|result)(?::(run-\d+))?$/.exec(text);
		if (last?.role === "user" && command) {
			const [, action, runId] = command;
			const name = action === "stop" || action === "result" ? "intercom" : "delegate";
			const args = name === "delegate" ? { agent: "package-worker", task: `PACKAGE_WORK:${action}` } : { action, to: runId };
			return fauxAssistantMessage(fauxToolCall(name, args, { id: `qualification-${action}` }), { stopReason: "toolUse" });
		}
		return fauxAssistantMessage("PACKAGE_SUPERVISOR_ACK");
	};
	const stream = (model, context, options) => {
		if (model.provider !== "package-qualification") throw new Error("Non-fixture provider request");
		receipt("faux_request", { provider: model.provider, model: model.id });
		faux.appendResponses([respond]);
		return faux.provider.streamSimple(model, context, options);
	};
	pi.registerProvider({ ...faux.provider, stream, streamSimple: stream });
	pi.on("session_start", () => receipt("session_start", { tools: pi.getAllTools().map((tool) => tool.name) }));
	pi.on("session_shutdown", () => receipt("session_shutdown"));
	pi.registerCommand("package-qualification-shutdown", { description: "Orderly fixture shutdown", handler: async (_args, ctx) => { ctx.shutdown(); } });
}
