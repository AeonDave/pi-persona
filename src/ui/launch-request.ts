/** Frozen caller-authored launch inputs. Literal rendering never treats a task as Markdown. */
import type { KeybindingHints } from "@earendil-works/pi-coding-agent";
import { expandDetailHint } from "../extension/shared.ts";
import { sanitizeTerminalText } from "./presentation.ts";
import { parseVerification, VERIFICATION_DEFAULT_TIMEOUT_MS, type WorktreeVerificationSpec } from "../core/worktree-verification.ts";

export interface LaunchRequest {
	task: string;
	role?: string;
	skills?: string[];
	verification?: WorktreeVerificationSpec;
}

export function snapshotLaunchRequest(request: LaunchRequest): LaunchRequest {
	return { task: request.task, ...(request.role ? { role: request.role } : {}), ...(request.skills ? { skills: [...request.skills] } : {}), ...(request.verification ? { verification: { ...request.verification } } : {}) };
}

export function readLaunchRequest(value: unknown): LaunchRequest | undefined {
	if (!value || typeof value !== "object") return undefined;
	const request = value as Record<string, unknown>;
	if (typeof request.task !== "string") return undefined;
	const verification = parseVerification(request.verification);
	return { task: request.task,
		...(typeof request.role === "string" ? { role: request.role } : {}),
		...(Array.isArray(request.skills) && request.skills.every((skill) => typeof skill === "string") ? { skills: [...request.skills] as string[] } : {}),
		...(verification.ok ? { verification: verification.value } : {}),
	};
}

export function launchRequestLines(request: LaunchRequest | undefined): string[] {
	if (!request) return ["Task unavailable in this saved launch."];
	return ["Task:", sanitizeTerminalText(request.task),
		...(request.role ? ["Role:", sanitizeTerminalText(request.role)] : []),
		...(request.skills?.length ? [`Skills: ${request.skills.map(sanitizeTerminalText).join(", ")}`] : []),
		...(request.verification ? ["Verification after worker completion:", sanitizeTerminalText(request.verification.command), `Deadline: ${request.verification.timeoutMs ?? VERIFICATION_DEFAULT_TIMEOUT_MS} ms; cwd: isolated worktree`] : []),
	];
}

/** The native tool card owns click and expand-key handling; every hidden request advertises it. */
export function hiddenLaunchRequestHint(request: LaunchRequest | undefined, hints?: Pick<KeybindingHints, "keyHint">): string | undefined {
	return request ? expandDetailHint(hints) : undefined;
}
