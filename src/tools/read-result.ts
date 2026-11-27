import { defineTool } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { renderPendingCall } from "../ui/pending-call.ts";
import { Type } from "typebox";
import { fenceUntrusted } from "../core/fence.ts";
import { RESULT_READ_DEFAULT, RESULT_READ_MAX } from "../results/types.ts";
import { isReadRequest, isReadReplyFor, isReadPageDetails, readFailure, type ReadPageDetails, type ReadReply, type ScopedReader } from "../bus/result-reader.ts";
import { compactInlineText } from "../ui/presentation.ts";
import { renderLiteralPreview, renderLiteralToolResult } from "../ui/literal-tool-result.ts";

const Params = Type.Object({
	ref: Type.String({ minLength: 43, maxLength: 43, description: "Granted opaque result:<UUID> reference, not a file path or run id." }),
	offset: Type.Optional(Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER, description: "UTF-16 offset; use nextOffset from the previous page." })),
	limit: Type.Optional(Type.Integer({ minimum: 2, maximum: RESULT_READ_MAX, default: RESULT_READ_DEFAULT, description: "Maximum UTF-16 characters to read." })),
}, { additionalProperties: false });

/** Available only when the parent explicitly grants a scoped reader. No archive browsing,
 * implicit fallback, polling, messages or model wakes. Fencing happens exactly once here.
 * Wrapped in `defineTool` so callers that store the definition in a wider-typed variable
 * (engine registration sites) keep renderer parameter inference. */
export function makeReadResultTool(reader: Pick<ScopedReader, "read">) {
	return defineTool<typeof Params, ReadPageDetails>({
		name: "read_result",
		label: "Read result",
		description: "Read one bounded page of a terminal result explicitly granted by your supervisor. Use only a supplied result:<UUID> reference. Follow nextOffset for another page; endOfStoredBody ends the retained report, which may be truncated. No search, paths, live runs or polling.",
		parameters: Params,
		async execute(_id, request, signal) {
			if (signal?.aborted) throw new Error(readFailure("cancelled").message);
			if (!isReadRequest(request)) throw new Error(readFailure("invalid").message);
			let result: ReadReply;
			try { result = await reader.read(request, signal); }
			catch { throw new Error(readFailure(signal?.aborted ? "cancelled" : "unavailable").message); }
			if (signal?.aborted) throw new Error(readFailure("cancelled").message);
			try {
				if (!isReadReplyFor(result, request)) throw new Error();
			} catch { throw new Error(readFailure("protocol").message); }
			if (!result.ok) throw new Error(result.message);
			const { body, ...details } = result;
			return { content: [{ type: "text", text: `${JSON.stringify(details)}\n${fenceUntrusted(body)}` }], details };
		},
		renderCall(args, theme, context) {
			const pending = renderPendingCall("read_result", theme, context);
			if (pending) return pending;
			const ref = compactInlineText(args.ref ?? "", { maxChars: 48 });
			return new Text(`${theme.fg("toolTitle", theme.bold("read_result"))}${ref ? ` ${theme.fg("dim", ref)}` : ""}`, 0, 0);
		},
		renderResult(result, { expanded }, theme, context) {
			const page = result.details;
			const part = result.content[0];
			if (expanded || (context?.isError ?? result.isError) || !isReadPageDetails(page) ||
				result.content.length !== 1 || part?.type !== "text") return renderLiteralToolResult(result, { expanded }, theme, context);

			// Replace just the machine header emitted by execute. Preserve quoted lines verbatim, including
			// body text that happens to look like JSON. Unknown history retains the full literal fallback.
			const end = page.nextOffset ?? page.storedChars;
			const header = JSON.stringify(page) + "\n";
			if (!part.text.startsWith(header + fenceUntrusted(""))) return renderLiteralToolResult(result, { expanded }, theme, context);
			const position = `UTF-16 [${page.offset},${end})/${page.storedChars}`;
			const source = `${page.status} run · ${page.provenance.replace("-", " ")} · ${position}${page.truncated ? " · truncated" : ""}`;
			const body = page.offset === end ? "(empty page)" : part.text.slice(header.length);
			return renderLiteralPreview(body, theme, context, { heading: theme.fg("accent", source), maxLines: 3, hasDetails: true });
		},
	});
}
