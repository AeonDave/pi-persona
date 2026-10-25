/** Runtime validation and TypeBox schemas for the Exocom collaboration tools. */
import { type Static, Type } from "typebox";

import { writeSetPathError } from "../core/ownership.ts";

const TOKEN = { minLength: 1, maxLength: 128, pattern: "^[A-Za-z0-9._:-]+$" } as const;
export const TaskParams = Type.Object({
	action: Type.Union([Type.Literal("create"), Type.Literal("take"), Type.Literal("progress"), Type.Literal("finish"), Type.Literal("list"), Type.Literal("get")], {
		description: "Choose list to discover tasks (do not pass work_key or task_id); use get with both identifiers returned by create/list to inspect one exact task generation.",
	}),
	work_key: Type.Optional(Type.String({ ...TOKEN, description: "Required for create, take, progress, finish, and get. Omit for list. Pair with task_id for an existing task." })),
	task_id: Type.Optional(Type.String({ ...TOKEN, description: "Generation id returned by create or list. Required with work_key for take, progress, finish, and get; omit for create and list." })),
	description: Type.Optional(Type.String({ minLength: 1, maxLength: 2_048 })),
	write_set: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 256 }), { maxItems: 64 })),
	note: Type.Optional(Type.String({ minLength: 1, maxLength: 4_096 })),
	outcome: Type.Optional(Type.Union([Type.Literal("done"), Type.Literal("abandoned")])),
	offset: Type.Optional(Type.Integer({ minimum: 0, maximum: 64 })),
	limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20, description: "Rows per page: defaults to 10 for summaries or 5 when detail=true. Detailed pages allow at most 5." })),
	detail: Type.Optional(Type.Boolean({ description: "Include peer-authored task/progress prose. Detailed lists default to 5 rows and reject an explicit limit above 5." })),
});
export const OfferParams = Type.Object({
	work_key: Type.String({ ...TOKEN }),
	task_id: Type.String({ ...TOKEN }),
	target: Type.Optional(Type.String({ minLength: 1, maxLength: 80 })),
	expiresInMinutes: Type.Optional(Type.Integer({ minimum: 1, maximum: 1_440 })),
});
export const PublishParams = Type.Object({
	action: Type.Union([Type.Literal("publish"), Type.Literal("read")]),
	work_key: Type.Optional(Type.String({ ...TOKEN })),
	task_id: Type.Optional(Type.String({ ...TOKEN })),
	title: Type.Optional(Type.String({ minLength: 1, maxLength: 160 })),
	excerpt: Type.Optional(Type.String({ minLength: 1, maxLength: 4_096 })),
	msg_id: Type.Optional(Type.String({ ...TOKEN })),
	offset: Type.Optional(Type.Integer({ minimum: 0, maximum: 64 })),
	limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
});

type RecordValue = Record<string, unknown>;
const isRecord = (value: unknown): value is RecordValue => !!value && typeof value === "object" && !Array.isArray(value);
const isToken = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9._:-]{1,128}$/.test(value);
function invalid(tool: string, field: string, expected: string): never {
	throw new Error(`${tool}: ${field} ${expected}`);
}
function exactKeys(tool: string, value: RecordValue, allowed: readonly string[]): void {
	const unexpected = Object.keys(value).find((key) => !allowed.includes(key));
	if (unexpected) invalid(tool, unexpected, "is not a supported parameter");
}
function boundedString(tool: string, field: string, value: unknown, max: number): string {
	if (typeof value !== "string" || value.length < 1 || value.length > max) invalid(tool, field, `must be 1–${max} characters`);
	return value;
}
function tokenField(tool: string, field: string, value: unknown): string {
	if (!isToken(value)) invalid(tool, field, "must be 1–128 token characters matching [A-Za-z0-9._:-]");
	return value;
}
function objectInput(tool: string, input: unknown): RecordValue {
	if (!isRecord(input)) invalid(tool, "parameters", "must be an object");
	return input;
}

export type TaskInput =
	| { action: "list"; offset: number; limit: number; detail: boolean }
	| { action: "get"; work_key: string; task_id: string }
	| { action: "create"; work_key: string; description: string; write_set: string[] }
	| { action: "take"; work_key: string; task_id: string }
	| { action: "progress"; work_key: string; task_id: string; note: string }
	| { action: "finish"; work_key: string; task_id: string; note: string; outcome: "done" | "abandoned" };

export function parseTaskInput(input: unknown): TaskInput {
	const tool = "exocom_task";
	const value = objectInput(tool, input);
	if (typeof value.action !== "string" || !["create", "take", "progress", "finish", "list", "get"].includes(value.action)) invalid(tool, "action", "must be create, take, progress, finish, list, or get");
	const action = value.action as "create" | "take" | "progress" | "finish" | "list" | "get";
	if (action === "list") {
		exactKeys(tool, value, ["action", "offset", "limit", "detail"]);
		const offset = value.offset === undefined ? 0 : value.offset;
		const detail = value.detail === undefined ? false : value.detail;
		const limit = value.limit === undefined ? (detail ? 5 : 10) : value.limit;
		if (!Number.isInteger(offset) || (offset as number) < 0 || (offset as number) > 64) invalid(tool, "offset", "must be an integer from 0 to 64");
		if (!Number.isInteger(limit) || (limit as number) < 1 || (limit as number) > 20) invalid(tool, "limit", "must be an integer from 1 to 20");
		if (typeof detail !== "boolean") invalid(tool, "detail", "must be a boolean");
		return { action, offset: offset as number, limit: limit as number, detail };
	}
	if (action === "get") {
		exactKeys(tool, value, ["action", "work_key", "task_id"]);
		return { action, work_key: tokenField(tool, "work_key", value.work_key), task_id: tokenField(tool, "task_id", value.task_id) };
	}
	if (action === "create") {
		exactKeys(tool, value, ["action", "work_key", "description", "write_set"]);
		const work_key = tokenField(tool, "work_key", value.work_key);
		const description = boundedString(tool, "description", value.description, 2_048);
		const write_set = value.write_set === undefined ? [] : value.write_set;
		if (!Array.isArray(write_set) || write_set.length > 64 || write_set.some((path) => typeof path !== "string" || path.length < 1 || path.length > 256)) {
			invalid(tool, "write_set", "must contain at most 64 paths of 1–256 characters");
		}
		for (const path of write_set as string[]) {
			const issue = writeSetPathError(path);
			if (issue) invalid(tool, "write_set path", `is invalid (${issue})`);
		}
		return { action, work_key, description, write_set: write_set as string[] };
	}
	const work_key = tokenField(tool, "work_key", value.work_key);
	if (action === "take") {
		exactKeys(tool, value, ["action", "work_key", "task_id"]);
		return { action, work_key, task_id: tokenField(tool, "task_id", value.task_id) };
	}
	if (action === "progress") {
		exactKeys(tool, value, ["action", "work_key", "task_id", "note"]);
		return { action, work_key, task_id: tokenField(tool, "task_id", value.task_id), note: boundedString(tool, "note", value.note, 4_096) };
	}
	exactKeys(tool, value, ["action", "work_key", "task_id", "note", "outcome"]);
	if (value.outcome !== "done" && value.outcome !== "abandoned") invalid(tool, "outcome", "must be done or abandoned");
	return { action, work_key, task_id: tokenField(tool, "task_id", value.task_id), note: boundedString(tool, "note", value.note, 4_096), outcome: value.outcome };
}

export function parseOfferInput(input: unknown) {
	const value = objectInput("exocom_offer", input);
	exactKeys("exocom_offer", value, ["work_key", "task_id", "target", "expiresInMinutes"]);
	const work_key = tokenField("exocom_offer", "work_key", value.work_key);
	const task_id = tokenField("exocom_offer", "task_id", value.task_id);
	let target: string | undefined;
	if (value.target !== undefined) {
		const raw = boundedString("exocom_offer", "target", value.target, 80);
		if (raw === "*") invalid("exocom_offer", "target", "must name one peer, never *");
		if (!/^[^\p{Cc}\p{Zl}\p{Zp}<>]+$/u.test(raw) || raw !== raw.trim()) invalid("exocom_offer", "target", "must exactly match a clean public target from exocom_list");
		target = raw;
	}
	const expiresInMinutes = value.expiresInMinutes === undefined ? 60 : value.expiresInMinutes;
	if (!Number.isInteger(expiresInMinutes) || (expiresInMinutes as number) < 1 || (expiresInMinutes as number) > 1_440) {
		invalid("exocom_offer", "expiresInMinutes", "must be an integer from 1 to 1440");
	}
	return { work_key, task_id, target, expiresInMinutes: expiresInMinutes as number };
}

export type PublishInput =
	| { action: "read"; msg_id: string }
	| { action: "read"; work_key: string; task_id?: string; offset: number; limit: number }
	| { action: "publish"; work_key: string; task_id: string; title: string; excerpt: string };

export function parsePublishInput(input: unknown): PublishInput {
	const value = objectInput("exocom_publish", input);
	if (value.action === "read") {
		if (value.msg_id !== undefined) {
			exactKeys("exocom_publish", value, ["action", "msg_id"]);
			return { action: "read", msg_id: tokenField("exocom_publish", "msg_id", value.msg_id) };
		}
		exactKeys("exocom_publish", value, ["action", "work_key", "task_id", "offset", "limit"]);
		const work_key = tokenField("exocom_publish", "work_key", value.work_key);
		const task_id = value.task_id === undefined ? undefined : tokenField("exocom_publish", "task_id", value.task_id);
		const offset = value.offset === undefined ? 0 : value.offset;
		const limit = value.limit === undefined ? 10 : value.limit;
		if (!Number.isInteger(offset) || (offset as number) < 0 || (offset as number) > 64) invalid("exocom_publish", "offset", "must be an integer from 0 to 64");
		if (!Number.isInteger(limit) || (limit as number) < 1 || (limit as number) > 20) invalid("exocom_publish", "limit", "must be an integer from 1 to 20");
		return { action: "read", work_key, ...(task_id === undefined ? {} : { task_id }), offset: offset as number, limit: limit as number };
	}
	if (value.action !== "publish") invalid("exocom_publish", "action", "must be publish or read");
	exactKeys("exocom_publish", value, ["action", "work_key", "task_id", "title", "excerpt"]);
	const work_key = tokenField("exocom_publish", "work_key", value.work_key);
	const task_id = tokenField("exocom_publish", "task_id", value.task_id);
	const title = boundedString("exocom_publish", "title", value.title, 160);
	const excerpt = boundedString("exocom_publish", "excerpt", value.excerpt, 4_096);
	if (Buffer.byteLength(excerpt, "utf8") > 8_192) invalid("exocom_publish", "excerpt", "must be at most 8192 UTF-8 bytes");
	return { action: "publish", work_key, task_id, title, excerpt };
}

export type TaskParamsType = Static<typeof TaskParams>;
export type OfferParamsType = Static<typeof OfferParams>;
export type PublishParamsType = Static<typeof PublishParams>;
