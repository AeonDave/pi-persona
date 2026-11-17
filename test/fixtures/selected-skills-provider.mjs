import { appendFileSync } from "node:fs";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";

export default function (pi) {
	const provider = fauxProvider({ provider: "skill-child-test", models: [{ id: "local" }] });
	const stream = (model, context, options) => {
		appendFileSync(process.env.SELECTED_SKILLS_RECEIPT, `${JSON.stringify(context.messages)}\n`);
		provider.appendResponses([fauxAssistantMessage("selected-skills-child-ok")]);
		return provider.provider.streamSimple(model, context, options);
	};
	pi.registerProvider({ ...provider.provider, stream, streamSimple: stream });
}
