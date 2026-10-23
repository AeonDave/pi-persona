/**
 * Seeding the bundled defaults into the user's Pi agent dir, so a user can edit/extend them
 * and the supervisor always runs the user's copies (they shadow the builtin by discovery
 * precedence). `force` overwrites existing files — that is the "restore originals" command;
 * non-force keeps user edits (first run / pulling in new defaults).
 *
 * Layout mirrors discovery: personas + agents live together under `<user>/agents` (classified
 * by `persona: true`), teams in `<user>/teams.yaml`, the spine pair flat in `<user>` (bundled
 * under `prompts/`, but that is where `resolveSpine` looks), and flows/contracts/presets in
 * their own `<user>/<kind>` dirs. Persona and agent names are one shared namespace at runtime; a
 * colliding seed is reported and the persona wins the single shared user file. The loader then
 * reports the ambiguity instead of silently splitting the namespaces.
 *
 * Pure over node:fs (no Pi imports), so the copy/skip logic is unit-tested with temp dirs.
 */

import { createHash, randomUUID } from "node:crypto";
import {
	closeSync,
	constants,
	copyFileSync,
	existsSync,
	fstatSync,
	linkSync,
	lstatSync,
	mkdirSync,
	openSync,
	readSync,
	readdirSync,
	renameSync,
	rmSync,
} from "node:fs";
import { dirname, join } from "node:path";

const SPINE_FILES = ["spine.md", "spine.worker.md"] as const;
type SpineFile = (typeof SPINE_FILES)[number];

/** Exact bytes shipped in v1.8.0 and copied by `/persona seed`. v1.8.1 rewrote both prompts, but
 *  `on` prefers the seeded user file, so those pristine copies otherwise shadow the rewrite forever.
 *  Detection is deliberately read-only: a single user edit changes the digest and is preserved,
 *  while an exact legacy copy can be bypassed by resolution without risking a concurrent edit. */
const LEGACY_SPINE_SHA256: Readonly<Record<SpineFile, string>> = {
	"spine.md": "36c304f0bf9bf1114342cde8cd638adec004a6a50415e17d23c90c82e2394b7b",
	"spine.worker.md": "33dbe81db24602f208a23957c88e638aff1bad38c4038b7356350c75d898f936",
};
const LEGACY_SPINE_SIZE: Readonly<Record<SpineFile, number>> = {
	"spine.md": 2714,
	"spine.worker.md": 1436,
};

export interface SpineLegacySelection {
	supervisor: boolean;
	worker: boolean;
}

export interface SpineLegacyResult {
	/** Exact pristine v1.8.0 user files. Callers may skip these as resolution candidates. */
	legacy: string[];
	warnings: string[];
}

/** The small portion of `fs.Stats` needed to reject links and revalidate an opened file. */
export interface SpineLegacyStat {
	dev: number;
	ino: number;
	nlink: number;
	size: number;
	isFile(): boolean;
}

/** Per-activation filesystem seam. Production leaves it empty; tests can prove rejected files are
 *  never opened/read and that the content read is bounded without replacing process-wide `node:fs`. */
export interface SpineLegacyIO {
	lstat?: (path: string) => SpineLegacyStat;
	open?: (path: string) => number;
	fstat?: (fd: number) => SpineLegacyStat;
	/** Read at most `maxBytes` from offset zero. */
	read?: (fd: number, maxBytes: number) => Buffer;
	close?: (fd: number) => void;
}

export interface SeedResult {
	/** Absolute paths written. */
	copied: string[];
	/** Absolute paths left untouched (already existed, or a persona owned a colliding name). */
	skipped: string[];
	/** Basenames present in both bundled persona and agent sources; the persona wins seeding. */
	collisions?: string[];
	/** Per-file failures (a destination locked by an editor/AV on Windows, EACCES…). One bad
	 *  file must not abort the whole seed: the rest still lands and each failure is named. */
	warnings?: string[];
}

/** Exact bytes from earlier releases whose seeded copies are known to be stale. A user file is
 * eligible only when BOTH size and digest match. Keep this explicit allow-list deliberately
 * small: it is a migration policy, not a fuzzy upgrader. Before tagging a release, add the
 * previous tag's digest for every changed asset; the guard test in seed.test.ts prints the row. */
export interface SeededDefaultSpec {
	size: number;
	sha256: string;
	/** Bundled agent files that must exist before this parent default may be migrated. */
	requiredAdditions?: readonly string[];
}

/** One seeded asset can have several known-pristine historical byte sequences. */
export type SeededDefaultEntry = SeededDefaultSpec | readonly SeededDefaultSpec[];

const ELITE_REQUIRED_ADDITIONS = ["agents/evidence-verifier.md"] as const;
/** A migrated planner declares the `design` loop, whose generator is the `architect` agent. */
const PLANNER_REQUIRED_ADDITIONS = ["agents/architect.md"] as const;

export const LEGACY_SEEDED_DEFAULTS: Readonly<Record<string, SeededDefaultEntry>> = {
	"personas/dev.md": [
		// v1.17.2 pristine seed (LF and CRLF checkout variants).
		{ size: 2712, sha256: "2dff44e3c6626d5eb35c5a9d74d77e345c95319bb6d310101ba53f6f330165b4" },
		{ size: 2757, sha256: "afdafb105c14a4e4ed960969779f4059491d85bf463739cf01079fe9831ace5b" },
		// v1.13.4 pristine seed (LF and CRLF checkout variants)
		{ size: 5907, sha256: "1d7abbc482a26c452e2588e405bdcb60af536df1f81aa0b709dcff70554915d2" },
		{ size: 5977, sha256: "a1b46938316636bc90f525d031490eef3ee46363abe3aa199b267449b8bff06a" },
		// Current pre-Exocom-scope prompt (LF and CRLF checkout variants).
		{ size: 3170, sha256: "caf493d2df543303c5c49731747be033ce7169749f2e5d2939aa0ae6432ff0b5" },
		{ size: 3221, sha256: "40f6f682d0adbeee8e2221b7ab3525666b64816bf40af981fbdc88d6aef46671" },
		{ size: 3985, sha256: "fb02263d97c53d6c10b6089c9c65ae7fad27a77c28434b5c892dbb87dd285e5b" },
		// v1.10.5–v1.12.0
		{ size: 5194, sha256: "0899ee3b10971c2b324e9e9c868fcab833ea80a80b83d94a1f0a95147475e9b5" },
		// v1.12.1
		{ size: 5195, sha256: "54da40a44a777f8a3b36b6c038248116e19be5a6515707747d070dc3f32ead56" },
		// v1.14.0–v1.17.1 pristine seed (LF and CRLF checkout variants).
		{ size: 3292, sha256: "d058a5cf683fa178ffb6c6fc98172328680d0fb19e21cf46a24d42613b5c48de" },
		{ size: 3344, sha256: "a11cd85fd22b1c426c5fe148ceab8550f1815aace0702566fea3ad742bc25c13" },
	],
	"personas/planner.md": [
		// v1.13.4 pristine seed (LF and CRLF checkout variants)
		{ size: 3350, sha256: "78a1f1c88d4d779dca46414029a247e8c48db85b3b7266be9366c6dc23714d87", requiredAdditions: PLANNER_REQUIRED_ADDITIONS },
		{ size: 3397, sha256: "8055b7440f2cf1e79378196eda675bdeb5d58b8941d450f8901672cf82a9e876", requiredAdditions: PLANNER_REQUIRED_ADDITIONS },
		// v1.14.0–v1.17.1 pristine seed (LF and CRLF checkout variants).
		{ size: 2456, sha256: "a238aa8dbe01f42edc707585d1eccee3b63401eb1dbe91b607347a49624d27cb", requiredAdditions: PLANNER_REQUIRED_ADDITIONS },
		{ size: 2493, sha256: "f8f8a8cdb6110022984556a7102f523411053282f818249c20ec8e0153c810e1", requiredAdditions: PLANNER_REQUIRED_ADDITIONS },
	],
	"personas/researcher.md": [
		// v1.13.4 pristine seed (LF and CRLF checkout variants)
		{ size: 4441, sha256: "a3819ea76afee2a2f14d50c99198a09d4a4bd858e22ea9e4ceb3d868dcbb78c8" },
		{ size: 4498, sha256: "2bd9dcaf47bd4ef3d139be361d260fbf7c9caa523144548593cdfc7ea4a2246c" },
		// v1.14.0–v1.17.1 pristine seed (LF and CRLF checkout variants).
		{ size: 2606, sha256: "68a1e62ddde7b0b0ecfd165e699c76cf6d6f3d533b6d1051dc4d5a64e9968807" },
		{ size: 2643, sha256: "717fcd632de176e339928158516f35a6a4d82588e6ca36083726d1dbcfdc0e18" },
	],
	"personas/audit.md": [
		// v1.13.4 pristine seed (LF and CRLF checkout variants)
		{ size: 2110, sha256: "ea893333fc128a760455bb4eaac3ee2d384163f40950fca2c201b41860bd9d8a" },
		{ size: 2145, sha256: "04f2167437081d69806a704238411275006df98e6ee902bc0a8cb6eb81b0ef14" },
		// v1.14.0–v1.17.1 pristine seed (LF and CRLF checkout variants).
		{ size: 1636, sha256: "c35e053ef8578d93b1aa2efa4ecb97138ef84542f9cd7b524b1c7a267c4fdc05" },
		{ size: 1665, sha256: "0c8dd4e637570aa82b25070a9027a2f46bda25a25f2195d06df0ccb6d98bb211" },
	],
	"personas/verify.md": [
		// v1.13.4 pristine seed (LF and CRLF checkout variants)
		{ size: 1927, sha256: "4c670aba28ce15937d60074ec4ac7d50f6db3cccf137b60d9758627d69e82a0f" },
		{ size: 1955, sha256: "9696278c243f83c9e8ee5f128faacebb8a89f85464b2c182f1bb77365a6d5643" },
		// v1.14.0–v1.17.1 pristine seed (LF and CRLF checkout variants).
		{ size: 2127, sha256: "d17d2f73f13388f1c92a13045b7a6d1032aa6b710ab4147dfc2eacd27f07a522" },
		{ size: 2158, sha256: "7e26e68b77793e7349a2945f7674d5a116e3d1cfc5299e038d7b3a468e977ab2" },
	],
	// v1.7.0–v1.17.1 pristine seeds (LF and CRLF checkout variants); these two had no row before.
	"personas/judge.md": [
		{ size: 1778, sha256: "2f8c987de59d0f2aac6bdb62f556fc5937605d1036b4a42c8ada7a48461d4710" },
		{ size: 1810, sha256: "3f0287dd7052f1f0bc65b40dc3af52847c0e5b2295cfcb4001ebe345b9e3fadc" },
	],
	"personas/magi.md": [
		{ size: 2361, sha256: "a608fc26a13070fad79b84f9d1a5f39fd3b760aefb98732f1f95134a89cd0366" },
		{ size: 2402, sha256: "0b24f01d93517d5fc56a7318d374ee679fa146e919e86e753f422f9f10a37bda" },
	],
	// The MAGI cores gained `purpose:` (their verticalization) in v1.10.6. Agents are seeded COPIES,
	// not a live layer read from the package, so without these an existing install keeps three cores
	// that render as bare names — the label feature would ship inert for everyone who already has them.
	// Each core lists v1.0.0–v1.10.5, then v1.11.0–v1.14.0 (adds the confidence tie-break paragraph).
	"agents/melchior.md": [
		{ size: 1503, sha256: "aa7a69296640f1023e00e2f2285b12cfdee158bb89f7b0b3d8c03a6317de9508" },
		{ size: 1523, sha256: "8a78c1ff201d728187fe19f19ea5f62f2d02f67c5cc5c3a9e5255c8776cbe74d" },
		// v1.17.1 pristine seed (LF and CRLF checkout variants).
		{ size: 1747, sha256: "43ab5f65ecb89260c09b7e33daef3b68b1bc1c60c81b73b245fdf9984f601044" },
		{ size: 1779, sha256: "6b4dcc0cc7416ac9a4543b7330edaeefb29b1006cc5e67b86f15ca94c4eaaf24" },
	],
	"agents/balthasar.md": [
		{ size: 1527, sha256: "27273ed49ea265f528efad4724e6abec6d051fa60d1f4fa678982e7383364981" },
		{ size: 1549, sha256: "9e91de81e76dc6fab13ed5a6d0c26319ca89da8da6fb5c71c8d852fcb86b73f0" },
		// v1.17.1 pristine seed (LF and CRLF checkout variants).
		{ size: 1773, sha256: "6716f5c68f2eb0bc1e72b33cef3e78b062efa07a01d12edb95e671a482832753" },
		{ size: 1805, sha256: "baafecc02b01c962bfc933b3f3f768808d541c85b0e01b29f6ff04a710f6d716" },
	],
	"agents/casper.md": [
		{ size: 1508, sha256: "5074341b7e1ae7e9a44bc71de0405a17ccb404eacfaeb2fcf40f2ac4c23828ea" },
		{ size: 1531, sha256: "97f2fd367b7c13bfaec39d9bd61065023ef501a519d95e516e39842c487f9427" },
		// v1.17.1 pristine seed (LF and CRLF checkout variants).
		{ size: 1832, sha256: "32effd595231b7bb6ce6af01c87108bb030d489cc8758946206161e148e270e4" },
		{ size: 1865, sha256: "9d22349de3252074ba7d1482ee942c36e384181939ec71f1fddfd4c527d3d436" },
	],
	// Current pristine seed before the compact-digest/reusable-artifact prompt update (LF and CRLF).
	"agents/research.md": [
		{ size: 3771, sha256: "6d084d11c84a594ddac0986bcf81aea6e5768b9df18196fedc8715bfd3f1eb16" },
		{ size: 3825, sha256: "768899c4c9a5f60a8ff18602d7ee5a696414fd35a8d53e6ae2cc9dfa41d7a88f" },
		// v1.17.1 pristine seed (LF and CRLF checkout variants).
		{ size: 4132, sha256: "bb35ec537ae654bf60e8552721dfd797db34b5dd5f623b23a95adf2cd72c70e0" },
		{ size: 4190, sha256: "b579b08e6a9035b8ec9e55166f7bbe3dd11d421edca4e0df6146ceff4fe3d459" },
	],
	// v1.14.1 pristine seed (LF and CRLF checkout variants).
	"agents/evidence-verifier.md": [
		{ size: 1465, sha256: "428be556abbbd530826631ef255cd7effa3484b00b0c7c35877e8b0c9a786aef" },
		{ size: 1487, sha256: "5e4b2b41700bf7b669769f40dd5e98b41db0d708e1dec75697d06fd6abeaa2a1" },
		// v1.17.1 pristine seed (LF and CRLF checkout variants).
		{ size: 1560, sha256: "4fa0af121789e4408bde6ae1d8ced73c7b42adf31e4bf48121621e1047b09861" },
		{ size: 1583, sha256: "3156e4748dc32bfd0d4699054a0a8407f7110270ce717af774d54d34d0e98d13" },
	],
	// v1.17.1 pristine seeds (LF and CRLF checkout variants); these four had no row before.
	"agents/operator.md": [
		{ size: 4598, sha256: "be7a18654c6106c8fa3be9694c75ef375d17bf13789bfce9ed1f76012d646d59" },
		{ size: 4661, sha256: "9031054af66bca2b726536e5348f6d0223f66bb7b544cc256457b015d55c850f" },
	],
	"agents/reviewer.md": [
		{ size: 3427, sha256: "8570b80e48a2b44dc364f7a41b3cd06741507329d91b0b9d7e1b716e7eaf7ee2" },
		{ size: 3476, sha256: "73f404259730719051f8e9aedb17ddd398304ed40068128cd97eae3a884b0912" },
	],
	"agents/scout.md": [
		{ size: 1341, sha256: "ffea9fe3643dbc0e5dea8ffc0722f41050374daed33e7f3a46378de36a630a62" },
		{ size: 1364, sha256: "425b8ef2c1141b602b2f67e47224f855a8a11f936affd4429272347678de8b58" },
	],
	"agents/verifier.md": [
		{ size: 1037, sha256: "ce8f161b1879084b336e2f24495a82aba7279f099b450852ba02db8b4850def5" },
		{ size: 1058, sha256: "78d7c9e7e6d961b0005d216968196dea28b8ef09a8ccd52b0f7a4de97754a800" },
	],
	"personas/elite.md": [
		// v1.17.2 pristine seed (LF and CRLF checkout variants).
		{ size: 17580, sha256: "5a45759f0c94ea090c8a537c59a6549449ed089d0f02fac9a09ba14b01a09ff2", requiredAdditions: ELITE_REQUIRED_ADDITIONS },
		{ size: 17835, sha256: "425e0f4fbeb855a788706eb278db4ed4c1026c59bedcca9768c258966ede1654", requiredAdditions: ELITE_REQUIRED_ADDITIONS },
		{
			// v1.0.0
			size: 10489,
			sha256: "a898364924b2f8fd2a60e8bd170650bc851c972f330f51f351be7390986629de",
			requiredAdditions: ELITE_REQUIRED_ADDITIONS,
		},
		{
			// v1.1.0
			size: 10325,
			sha256: "c3d9f969ad31bb6ecb2fef5ccc9e30fc88bfd8a215a865b91c66496976af78aa",
			requiredAdditions: ELITE_REQUIRED_ADDITIONS,
		},
		{
			// v1.2.0–v1.3.0
			size: 11162,
			sha256: "df2b01eed543eee7064006611e84c08e9c01498d7d18b37b1cd596bf604801ed",
			requiredAdditions: ELITE_REQUIRED_ADDITIONS,
		},
		{
			// v1.4.0
			size: 12001,
			sha256: "2aca09540abadfaebe4cd52a0803b31694406b9a5795419c43a52a92d53068c9",
			requiredAdditions: ELITE_REQUIRED_ADDITIONS,
		},
		{
			// v1.5.1–v1.5.2
			size: 12043,
			sha256: "a37f8130c04ab404101a36a145dcf5c27f91e5204562af15addd592849113ec7",
			requiredAdditions: ELITE_REQUIRED_ADDITIONS,
		},
		{
			// v1.6.0–v1.6.1
			size: 12739,
			sha256: "e688c82b41f8a6d0040c9c9523e7c109c2e3585194af1b43b99b8629be339eda",
			requiredAdditions: ELITE_REQUIRED_ADDITIONS,
		},
		{
			// v1.6.2–v1.6.3
			size: 13994,
			sha256: "3e1e841da9ddb0c478cbe5e3238fbf17ea032b07c03f319da5b45a1b1add59b2",
			requiredAdditions: ELITE_REQUIRED_ADDITIONS,
		},
		{
			// v1.7.0–v1.8.1
			size: 15970,
			sha256: "073f3c05f134df5d5daf8cd05df51dc15916300977a19d8b6dda3c8dd36abd1c",
			requiredAdditions: ELITE_REQUIRED_ADDITIONS,
		},
		{
			// v1.9.0–v1.10.5: migrate only untouched copies to the current hardened prompt.
			size: 16521,
			sha256: "e0ab767934b62e25e712ec31ebbc97dc780dff93d2e3855181f8bbe0086a4940",
			requiredAdditions: ELITE_REQUIRED_ADDITIONS,
		},
		{
			// v1.11.0–v1.12.1
			size: 18267,
			sha256: "dbe4a4da34338e4210b5abf9a902b4c56bba31eced1f00eb775e30b25ee37b90",
			requiredAdditions: ELITE_REQUIRED_ADDITIONS,
		},
		{
			// v1.12.2–v1.14.0
			size: 19312,
			sha256: "a817f6e76164a142a15ec843978942e31ab765ae463bdded3966c0863d010894",
			requiredAdditions: ELITE_REQUIRED_ADDITIONS,
		},
		{
			// v1.14.1 pristine seed (LF and CRLF checkout variants).
			size: 19417,
			sha256: "e64985de2708ef0715aa01b555f7e322b97b6dfbceca3c26913949f2c4e69f98",
			requiredAdditions: ELITE_REQUIRED_ADDITIONS,
		},
		{
			size: 19673,
			sha256: "69be3a81b6b20ff51e21f8a6730049a5f740dd00c069f21d1a5a2184fda97f24",
			requiredAdditions: ELITE_REQUIRED_ADDITIONS,
		},
		// v1.14.2–v1.16.1 and v1.16.2–v1.17.1 pristine seeds (LF and CRLF checkout variants each).
		{ size: 19575, sha256: "7a349e63abc07c60c3937eb01005c0567e27327ec13a79550fcfe7deb5f87630", requiredAdditions: ELITE_REQUIRED_ADDITIONS },
		{ size: 19831, sha256: "7b078a2b2c2339df1169351fd58c97d5e99e4b33bff00c43229e566f0a737701", requiredAdditions: ELITE_REQUIRED_ADDITIONS },
		{ size: 19585, sha256: "23146654476bc477c48ce972b13566a31198c41c1aa051540d25cfb45394ab9d", requiredAdditions: ELITE_REQUIRED_ADDITIONS },
		{ size: 19841, sha256: "2751df2d27066c1d7398be3cc4d72abc4ecba01fb757c34b949bf74d64154dcb", requiredAdditions: ELITE_REQUIRED_ADDITIONS },
	],
	// Live-peer collaboration landed in v1.12.2. Without these, a seeded copy from 1.7–1.12.1
	// (and the two earlier untouched hashes) keeps the pre-collaboration prompt forever.
	"personas/swarm.md": [
		// v1.17.2 pristine seed (LF and CRLF checkout variants).
		{ size: 2694, sha256: "72d17416941edb6f31ca86cff1de6fa6d85c5ba7ae0cd269d104c770c9e42bf2" },
		{ size: 2737, sha256: "303ddc6bd44f2f909765d99d8f753136dae9d8a635616d6e65523814e06131a1" },
		// v1.13.4 pristine seed (LF and CRLF checkout variants)
		{ size: 2729, sha256: "3d5060277ecaec717e87beb8d95b0fe9f3dc70fe5f0192823aa79b55f9e49507" },
		{ size: 2768, sha256: "b81910521e05d62e06abaf0f2a89bd18ad252ba968bb296cc85dea973028e7a5" },
		// Current pre-Exocom-scope prompt (LF and CRLF checkout variants).
		{ size: 2188, sha256: "bb7bfcc03f4b5239fb8dcd3552ee517ed3e0a8238edf05e21303085022f4018b" },
		{ size: 2220, sha256: "5c0d332d389e2ff59a79f0ca0a28c05424da9b2194fe78a78c667606e9ff806d" },
		{ size: 1857, sha256: "77de7f590fdede6ede4848be11b39fb16bfb4733687ac1b1244cc59e626874c6" }, // v1.1.0–v1.4.0
		{ size: 1955, sha256: "b7a7caa38c4d31c8cc27b85eb7facbf2339a024ad8d4cd2ba681a2a885de7646" }, // v1.5.1–v1.6.3
		{ size: 2285, sha256: "985a1c5455b2c81537a55b31daed216d7f67a897b3b2d5bde35d64f3779d6fe4" }, // v1.7.0–v1.12.1
		{ size: 2360, sha256: "ae0cfe758d9e1b9a4d2d4bad151999418e10e8291226764e7d155b44ce8ff5ea" }, // v1.14.0–v1.14.2
		// v1.15.0–v1.17.1 pristine seed (LF and CRLF checkout variants).
		{ size: 2570, sha256: "3e6537f555d35b396041166d38da5cb397e076d00c258e25992d2e6abb8a37ef" },
		{ size: 2608, sha256: "c54acac4f88a1dfbe7b21eb3c4bcea658896f953ea8de5d592bc06d2ad0f312a" },
	],
};

export interface SeedMigrationResult {
	/** Absolute user paths upgraded from an exact, known-pristine old default. */
	migrated: string[];
	/** Absolute user paths installed as required additions during an eligible migration. */
	installed: string[];
	/** Absolute user paths intentionally left alone (edited, unknown, absent, or unchanged). */
	skipped: string[];
	/** Absolute paths that could not be inspected or replaced safely. */
	warnings: string[];
}

export interface SeedMigrationOptions {
	/** Override the built-in allow-list in tests or for a future explicitly supported release. */
	legacyDefaults?: Readonly<Record<string, SeededDefaultEntry>>;
	/** Filesystem seams for bounded inspection and no-clobber replacement tests. */
	io?: SeedMigrationIO;
	/** Test-only race hook, called after the old target is moved to backup and before install. */
	beforeInstall?: (target: string, backup: string, staged: string) => void;
	/** Test seam for making the random staging suffix deterministic. Production uses randomUUID. */
	idFactory?: () => string;
}

export interface SeedMigrationIO extends SpineLegacyIO {
	copyFile?: (from: string, to: string, flags?: number) => void;
	link?: (from: string, to: string) => void;
	rename?: (from: string, to: string) => void;
	remove?: (path: string) => void;
}

function listByExt(dir: string, ext: string): string[] {
	try {
		return readdirSync(dir).filter((f) => f.toLowerCase().endsWith(ext));
	} catch {
		return []; // a bundled asset folder may be absent — that is fine
	}
}

interface ResolvedSpineLegacyIO {
	lstat(path: string): SpineLegacyStat;
	open(path: string): number;
	fstat(fd: number): SpineLegacyStat;
	read(fd: number, maxBytes: number): Buffer;
	close(fd: number): void;
}

/** Read through a descriptor into a fixed allocation. A file that grows after `fstat` can fill at
 * most expected-size + one byte, which is enough to reject it without ever loading the growth. */
function readBounded(fd: number, maxBytes: number): Buffer {
	const buffer = Buffer.alloc(maxBytes);
	let offset = 0;
	while (offset < maxBytes) {
		const read = readSync(fd, buffer, offset, maxBytes - offset, offset);
		if (read === 0) break;
		offset += read;
	}
	return buffer.subarray(0, offset);
}

function resolveLegacyIO(io: SpineLegacyIO): ResolvedSpineLegacyIO {
	return {
		lstat: io.lstat ?? lstatSync,
		open: io.open ?? ((path) => openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))),
		fstat: io.fstat ?? fstatSync,
		read: io.read ?? readBounded,
		close: io.close ?? closeSync,
	};
}

interface SpineFingerprint {
	dev: number;
	ino: number;
	nlink: number;
	size: number;
}

type Inspection =
	| { kind: "legacy" }
	| { kind: "skip" }
	| { kind: "warning"; detail: string };

function fingerprint(stat: SpineLegacyStat): SpineFingerprint {
	return { dev: stat.dev, ino: stat.ino, nlink: stat.nlink, size: stat.size };
}

function sameFingerprint(left: SpineFingerprint, right: SpineFingerprint): boolean {
	return left.dev === right.dev && left.ino === right.ino && left.nlink === right.nlink && left.size === right.size;
}

function safeLegacyShape(stat: SpineLegacyStat, expectedSize: number): boolean {
	return stat.isFile() && stat.nlink === 1 && stat.size === expectedSize;
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Inspect through an opened descriptor. The user-controlled path is never read until both lstat
 *  and fstat establish a single-link regular file of the exact known legacy size. */
function inspectLegacy(path: string, file: SpineFile, io: ResolvedSpineLegacyIO): Inspection {
	let before: SpineLegacyStat;
	try {
		before = io.lstat(path);
	} catch {
		return { kind: "skip" };
	}
	if (!safeLegacyShape(before, LEGACY_SPINE_SIZE[file])) return { kind: "skip" };

	let fd: number;
	try {
		fd = io.open(path);
	} catch (error) {
		return { kind: "warning", detail: `open failed: ${errorText(error)}` };
	}
	try {
		const opened = io.fstat(fd);
		if (!safeLegacyShape(opened, LEGACY_SPINE_SIZE[file])) return { kind: "skip" };
		if (!sameFingerprint(fingerprint(before), fingerprint(opened))) return { kind: "skip" };
		const bytes = io.read(fd, LEGACY_SPINE_SIZE[file] + 1);
		if (bytes.byteLength !== LEGACY_SPINE_SIZE[file]) return { kind: "skip" };
		const after = io.fstat(fd);
		if (!safeLegacyShape(after, LEGACY_SPINE_SIZE[file])) return { kind: "skip" };
		if (!sameFingerprint(fingerprint(opened), fingerprint(after))) return { kind: "skip" };
		if (createHash("sha256").update(bytes).digest("hex") !== LEGACY_SPINE_SHA256[file]) return { kind: "skip" };
		return { kind: "legacy" };
	} catch (error) {
		return { kind: "warning", detail: `inspection failed: ${errorText(error)}` };
	} finally {
		try {
			io.close(fd);
		} catch {
			// The descriptor has no further use; a close error cannot change the classification.
		}
	}
}

/** Find exact, pristine v1.8.0 seeded spine files already present in `userDir` without writing.
 * The extension uses the result to fall through to the current bundled prompt for selector `on`.
 * `/persona restore` remains the explicit, user-authorized operation that updates bytes on disk. */
export function inspectLegacySeededSpines(
	userDir: string,
	selection: SpineLegacySelection,
	ioOverrides: SpineLegacyIO = {},
): SpineLegacyResult {
	const result: SpineLegacyResult = { legacy: [], warnings: [] };
	const io = resolveLegacyIO(ioOverrides);
	for (const file of SPINE_FILES) {
		if (file === "spine.md" ? !selection.supervisor : !selection.worker) continue;
		const path = join(userDir, file);
		const inspection = inspectLegacy(path, file, io);
		if (inspection.kind === "legacy") result.legacy.push(path);
		else if (inspection.kind === "warning") result.warnings.push(`spine legacy inspection warning: ${path}: ${inspection.detail}`);
	}
	return result;
}

type SeedInspection =
	| { kind: "legacy"; fingerprint: SpineFingerprint; spec: SeededDefaultSpec }
	| { kind: "skip" }
	| { kind: "warning"; detail: string };

interface ResolvedSeedMigrationIO extends ResolvedSpineLegacyIO {
	copyFile(from: string, to: string, flags?: number): void;
	link(from: string, to: string): void;
	rename(from: string, to: string): void;
	remove(path: string): void;
}

function resolveSeedMigrationIO(io: SeedMigrationIO): ResolvedSeedMigrationIO {
	return {
		...resolveLegacyIO(io),
		copyFile: io.copyFile ?? copyFileSync,
		link: io.link ?? linkSync,
		rename: io.rename ?? renameSync,
		remove: io.remove ?? ((path) => rmSync(path, { force: true })),
	};
}

function seededDefaultSpecs(entry: SeededDefaultEntry): readonly SeededDefaultSpec[] {
	return Array.isArray(entry) ? entry : [entry as SeededDefaultSpec];
}

/** Inspect one explicitly allowlisted target through a bounded descriptor. Unrelated user files
 * never enter this function: the migration loop is keyed only by the explicit allow-list. Multiple
 * historical digests of the same size share one bounded read. */
function inspectPristineSeededDefault(path: string, entry: SeededDefaultEntry, io: ResolvedSpineLegacyIO): SeedInspection {
	let before: SpineLegacyStat;
	try {
		before = io.lstat(path);
	} catch {
		return { kind: "skip" };
	}
	const candidates = seededDefaultSpecs(entry).filter((spec) => safeLegacyShape(before, spec.size));
	const expectedSize = candidates[0]?.size;
	if (expectedSize === undefined) return { kind: "skip" };
	let fd: number;
	try {
		fd = io.open(path);
	} catch (error) {
		return { kind: "warning", detail: `open failed: ${errorText(error)}` };
	}
	try {
		const opened = io.fstat(fd);
		if (!safeLegacyShape(opened, expectedSize) || !sameFingerprint(fingerprint(before), fingerprint(opened))) return { kind: "skip" };
		const bytes = io.read(fd, expectedSize + 1);
		const after = io.fstat(fd);
		if (!safeLegacyShape(after, expectedSize) || !sameFingerprint(fingerprint(opened), fingerprint(after))) return { kind: "skip" };
		// The sentinel byte rejects growth without ever hashing/retaining unbounded user data.
		if (bytes.byteLength !== expectedSize) return { kind: "skip" };
		const digest = createHash("sha256").update(bytes).digest("hex");
		const matched = candidates.find((spec) => spec.sha256 === digest);
		if (!matched) return { kind: "skip" };
		return { kind: "legacy", fingerprint: fingerprint(after), spec: matched };
	} catch (error) {
		return { kind: "warning", detail: `inspection failed: ${errorText(error)}` };
	} finally {
		try {
			io.close(fd);
		} catch {
			// A descriptor close failure cannot make an inspected file safe to replace.
		}
	}
}

function isMissing(error: unknown): boolean {
	return (error as NodeJS.ErrnoException).code === "ENOENT";
}

function restoreBackupIfTargetMissing(target: string, backup: string, io: ResolvedSeedMigrationIO): boolean {
	try {
		io.lstat(target);
		return false;
	} catch (error) {
		if (!isMissing(error)) return false;
	}
	try {
		io.rename(backup, target);
		return true;
	} catch {
		return false;
	}
}

type AdditionInstallResult = { kind: "installed" | "present" } | { kind: "failed"; detail: string };

function userAgentTarget(userDir: string, relative: string): string | undefined {
	const normalized = relative.replaceAll("\\", "/");
	if (!normalized.startsWith("agents/") || normalized.includes("/../") || normalized.endsWith("/..") || normalized.includes("/./")) return undefined;
	const name = normalized.slice("agents/".length);
	if (!name || name.includes("/")) return undefined;
	return join(userDir, "agents", name);
}

function installMissingAddition(
	source: string,
	target: string,
	io: ResolvedSeedMigrationIO,
	idFactory: () => string,
): AdditionInstallResult {
	try {
		io.lstat(target);
		return { kind: "present" };
	} catch (error) {
		if (!isMissing(error)) return { kind: "failed", detail: `target inspection failed: ${errorText(error)}` };
	}
	const staged = `${target}.pi-persona-migrate-${process.pid}-${idFactory()}.tmp`;
	let stagedOwned = false;
	try {
		try {
			io.copyFile(source, staged, constants.COPYFILE_EXCL);
			stagedOwned = true;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "EEXIST") return { kind: "failed", detail: `staging path already exists; preserved: ${staged}` };
			return { kind: "failed", detail: `staging failed: ${errorText(error)}` };
		}
		try {
			io.link(staged, target);
			return { kind: "installed" };
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "EEXIST") return { kind: "present" };
			return { kind: "failed", detail: `install failed: ${errorText(error)}` };
		}
	} finally {
		if (stagedOwned) {
			try {
				io.remove(staged);
			} catch {
				// The addition is already linked; a stale temp is recoverable and diagnosed by parent.
			}
		}
	}
}

/**
 * Upgrade bundled persona/agent files whose user copy is byte-for-byte one of the explicitly
 * known pristine defaults from an older release. This operation is intentionally separate from
 * {@link seedDefaults}: normal seeding preserves every existing file, while activation may call
 * this function once to pick up a security/behavioral default without overwriting user work.
 *
 * The target is checked as a single-link regular file before and after reading, and is checked
 * once more immediately before replacement. A changed file, symlink, hard-link, missing asset,
 * or replacement error is skipped/reported rather than overwritten. The result is suitable for
 * `/doctor` and activation diagnostics; this function never throws for a per-file race.
 */
export function migratePristineSeededDefaults(
	bundledDir: string,
	userDir: string,
	options: SeedMigrationOptions = {},
): SeedMigrationResult {
	const migrated: string[] = [];
	const installed: string[] = [];
	const skipped: string[] = [];
	const warnings: string[] = [];
	const legacyDefaults = options.legacyDefaults ?? LEGACY_SEEDED_DEFAULTS;
	const io = resolveSeedMigrationIO(options.io ?? {});
	const idFactory = options.idFactory ?? randomUUID;
	for (const [relative, entry] of Object.entries(legacyDefaults)) {
		const source = join(bundledDir, relative);
		const name = relative.replace(/^.*[\\/]/, "");
		const target = join(userDir, "agents", name);
		if (!existsSync(source)) {
			skipped.push(target);
			continue;
		}
		const inspection = inspectPristineSeededDefault(target, entry, io);
		if (inspection.kind === "warning") {
			warnings.push(`seed migration inspection warning: ${target}: ${inspection.detail}`);
			continue;
		}
		if (inspection.kind !== "legacy") {
			skipped.push(target);
			continue;
		}
		const spec = inspection.spec;
		let additionsReady = true;
		for (const addition of spec.requiredAdditions ?? []) {
			const additionTarget = userAgentTarget(userDir, addition);
			if (!additionTarget) {
				warnings.push(`seed migration required addition is invalid: ${addition}`);
				additionsReady = false;
				break;
			}
			const additionSource = join(bundledDir, addition);
			if (!existsSync(additionSource)) {
				warnings.push(`seed migration required addition missing from bundle: ${additionSource}`);
				additionsReady = false;
				break;
			}
			const additionResult = installMissingAddition(additionSource, additionTarget, io, idFactory);
			if (additionResult.kind === "failed") {
				warnings.push(`seed migration required addition failed for ${target}: ${additionResult.detail}`);
				additionsReady = false;
				break;
			}
			if (additionResult.kind === "installed") installed.push(additionTarget);
		}
		if (!additionsReady) {
			skipped.push(target);
			continue;
		}
		const suffix = `${process.pid}-${idFactory()}`;
		const staged = `${target}.pi-persona-migrate-${suffix}.tmp`;
		const backup = `${target}.pi-persona-migrate-${suffix}.bak`;
		let stagedOwned = false;
		try {
			// Stage the trusted bundled bytes beside the target with exclusive creation. A stale
			// temp from a crashed prior run is never followed, overwritten, or removed by us.
			try {
				io.copyFile(source, staged, constants.COPYFILE_EXCL);
				stagedOwned = true;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "EEXIST") {
					warnings.push(`seed migration staging path already exists; preserved: ${staged}`);
					skipped.push(target);
					continue;
				}
				throw error;
			}
			let current: SpineLegacyStat;
			try {
				current = io.lstat(target);
			} catch {
				skipped.push(target);
				continue;
			}
			if (!safeLegacyShape(current, spec.size) || !sameFingerprint(inspection.fingerprint, fingerprint(current))) {
				skipped.push(target);
				continue;
			}
			// Move the old inode to a recoverable backup. Installing with a hard-link below makes
			// target creation atomic-visible and no-clobber: a concurrent writer that claims the
			// path causes link() to fail with EEXIST rather than replacing its bytes. Both paths
			// are siblings, so this is same-volume on POSIX and Windows/NTFS alike.
			io.rename(target, backup);
			const backupInspection = inspectPristineSeededDefault(backup, spec, io);
			if (backupInspection.kind !== "legacy") {
				if (!restoreBackupIfTargetMissing(target, backup, io)) warnings.push(`seed migration backup preserved: ${backup}`);
				warnings.push(`seed migration target changed before replacement: ${target}`);
				skipped.push(target);
				continue;
			}
			options.beforeInstall?.(target, backup, staged);
			try {
				io.link(staged, target);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "EEXIST") {
					// A concurrent custom edit won the path. Leave it untouched and discard only
					// the old known-pristine backup.
					io.remove(backup);
					warnings.push(`seed migration target changed during migration; preserved: ${target}`);
					skipped.push(target);
					continue;
				}
				if (!restoreBackupIfTargetMissing(target, backup, io)) warnings.push(`seed migration backup preserved: ${backup}`);
				throw error;
			}
			io.remove(backup);
			migrated.push(target);
		} catch (error) {
			warnings.push(`seed migration replacement warning: ${target}: ${errorText(error)}`);
		} finally {
			if (stagedOwned) {
				try {
					io.remove(staged);
				} catch {
					warnings.push(`seed migration temporary file remains: ${staged}`);
				}
			}
		}
	}
	return { migrated, installed, skipped, warnings };
}

/** Copy the bundled defaults under `bundledDir` into `userDir`. Returns what changed. */
export function seedDefaults(bundledDir: string, userDir: string, force: boolean): SeedResult {
	const copied: string[] = [];
	const skipped: string[] = [];
	const collisions: string[] = [];
	const warnings: string[] = [];
	const place = (src: string, dst: string): void => {
		// Per-file fault isolation, same posture as the migration path below: a locked or
		// unreadable destination is a warning, never an abort of the remaining defaults.
		try {
			placeFile(src, dst);
		} catch (error) {
			warnings.push(`${dst}: ${errorText(error)}`);
		}
	};
	const placeFile = (src: string, dst: string): void => {
		mkdirSync(dirname(dst), { recursive: true });
		if (!force) {
			// `existsSync` follows symlinks and leaves a TOCTOU window. Inspect the directory entry,
			// then still use exclusive creation so an editor/process that wins the race is preserved.
			try {
				lstatSync(dst);
				skipped.push(dst);
				return;
			} catch (error) {
				if (!isMissing(error)) throw error;
			}
			try {
				copyFileSync(src, dst, constants.COPYFILE_EXCL);
				copied.push(dst);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
				skipped.push(dst);
			}
			return;
		}

		// Restore is explicitly destructive for THIS directory entry, but must never write through
		// a user symlink/hard-link. Stage complete bytes beside it and atomically replace the entry;
		// readers see either old or new content, and another link to the old inode stays untouched.
		const staged = `${dst}.pi-persona-restore-${process.pid}-${randomUUID()}.tmp`;
		let stagedOwned = false;
		try {
			copyFileSync(src, staged, constants.COPYFILE_EXCL);
			stagedOwned = true;
			renameSync(staged, dst);
			stagedOwned = false;
			copied.push(dst);
		} finally {
			if (stagedOwned) rmSync(staged, { force: true });
		}
	};

	// Personas + agents share <user>/agents. Seed personas first so a colliding basename has one
	// deterministic on-disk owner; seedDefaults returns the collision names for diagnostics.
	const personaFiles = listByExt(join(bundledDir, "personas"), ".md");
	const ownedByPersona = new Set(personaFiles);
	for (const f of personaFiles) place(join(bundledDir, "personas", f), join(userDir, "agents", f));
	for (const f of listByExt(join(bundledDir, "agents"), ".md")) {
		if (ownedByPersona.has(f)) {
			collisions.push(f.slice(0, -3));
			skipped.push(join(userDir, "agents", f));
			continue;
		}
		place(join(bundledDir, "agents", f), join(userDir, "agents", f));
	}

	// flows / contracts / presets → their own user dirs.
	for (const [sub, ext] of [
		["flows", ".flow.json"],
		["contracts", ".contract.json"],
		["presets", ".preset.json"],
	] as const) {
		for (const f of listByExt(join(bundledDir, sub), ext)) place(join(bundledDir, sub, f), join(userDir, sub, f));
	}

	// The spine pair (docs/SPINE.md) — bundled under `prompts/`, seeded FLAT into the data dir,
	// because that is where `PI_PERSONA_SPINE=on` looks for the user's own copy. Without this the
	// documented "your own copy shadows the bundled one" precedence has no gesture that creates
	// the copy, and a user would have to know the two filenames and write them by hand.
	for (const f of SPINE_FILES) {
		const src = join(bundledDir, "prompts", f);
		const dst = join(userDir, f);
		if (existsSync(src)) place(src, dst);
	}

	// teams.yaml — a single merged file.
	const teamsSrc = join(bundledDir, "teams.yaml");
	if (existsSync(teamsSrc)) place(teamsSrc, join(userDir, "teams.yaml"));

	return { copied, skipped, ...(collisions.length > 0 ? { collisions } : {}), ...(warnings.length > 0 ? { warnings } : {}) };
}
