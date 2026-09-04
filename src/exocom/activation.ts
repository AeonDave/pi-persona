/**
 * Recover the optional value form Pi's extension-flag API cannot currently expose.
 *
 * Pi registers `exocom` as a boolean so the established bare `--exocom` keeps working.
 * Its CLI parser accepts `--exocom=<value>`, but boolean flag validation intentionally
 * collapses that value to `true`. Read only the exact equals form, before the ordinary
 * `--` option terminator; all enablement still flows through Pi's registered flag/config.
 */

export interface ExocomArgSelection {
	joinCode?: string;
	error?: string;
}

const CODE = /^[0-9A-Za-z]{4}$/;

export function parseExocomArgv(argv: readonly string[]): ExocomArgSelection {
	const explicit: string[] = [];
	for (const arg of argv) {
		if (arg === "--") break;
		if (!arg.startsWith("--exocom=")) continue;
		const value = arg.slice("--exocom=".length);
		if (!CODE.test(value)) {
			return { error: "--exocom join code must be exactly 4 Base62 characters (0-9, A-Z, a-z)" };
		}
		explicit.push(value);
	}
	const unique = [...new Set(explicit)];
	if (unique.length > 1) return { error: "conflicting --exocom join codes" };
	return unique[0] === undefined ? {} : { joinCode: unique[0] };
}
