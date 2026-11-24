import { scanNativeCustomEntries, type NativeCustomEntry, type NativeHistoryCursor } from "../io/native-history.ts";

export const CONVERSATION_ENTRY = "pi-persona:conversation:v1";
export const CONVERSATION_FORGOTTEN_ENTRY = "pi-persona:conversation-forgotten:v1";
const CONVERSATION_TYPES = new Set([CONVERSATION_ENTRY, CONVERSATION_FORGOTTEN_ENTRY]);

/** Cache only conversation metadata for this file, reading each newly appended byte once. */
export class ConversationHistory {
	private current: { file: string; sessionId: string; entries: NativeCustomEntry[]; cursor?: NativeHistoryCursor } | undefined;

	read(file: string, sessionId: string): readonly NativeCustomEntry[] {
		const previous = this.current;
		const state = previous?.file === file && previous.sessionId === sessionId ? previous : { file, sessionId, entries: [] };
		const added: NativeCustomEntry[] = [];
		try {
			const cursor = scanNativeCustomEntries(file, sessionId, CONVERSATION_TYPES, (entry) => { added.push(entry); }, state.cursor);
			if (cursor) {
				state.cursor = cursor;
				for (const entry of added) state.entries.push(entry);
			}
			this.current = state;
			return state.entries;
		} catch (error) {
			// Refuse the current read. A later attempt verifies the file header again.
			this.current = undefined;
			throw error;
		}
	}
}
