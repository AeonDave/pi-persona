import { fauxProvider, fauxAssistantMessage, fauxThinking, fauxToolCall } from "@earendil-works/pi-ai";

export default function (pi) {
	const faux = fauxProvider({ provider: "worker-chat-test", models: [{ id: "local", reasoning: true }] });
	const stream = (model, context, options) => {
		const last = context.messages.findLast((message) => message.role === "user" || message.role === "assistant" || message.role === "toolResult");
		faux.appendResponses([last?.role === "toolResult"
			? fauxAssistantMessage("CHAT ANSWER")
			: fauxAssistantMessage([fauxThinking("Inspect the actual file."), fauxToolCall("read", { path: "chat-input.txt" }, { id: `chat-read-${faux.state.callCount}` })], { stopReason: "toolUse" })]);
		return faux.provider.streamSimple(model, context, options);
	};
	pi.registerProvider({ ...faux.provider, stream, streamSimple: stream });
}
