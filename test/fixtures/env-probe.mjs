// Reports the PI_PERSONA_* environment a test process actually starts with. Run through the
// SAME `--import` chain the npm test scripts use, it is how the hermetic-env choke point is
// observed from the outside: whatever survives here is what a test file would have seen.
process.stdout.write(
	`${JSON.stringify({
		// Case-insensitive on purpose: on Windows `pi_persona_default` IS `PI_PERSONA_DEFAULT` as far
		// as `process.env.PI_PERSONA_DEFAULT` — and therefore resolveConfig() — is concerned. Matching
		// case-sensitively here would make this probe blind to exactly the leak it exists to catch.
		leaked: Object.keys(process.env)
			.filter((k) => k.toUpperCase().startsWith("PI_PERSONA_"))
			.sort(),
		agentDir: process.env.PI_AGENT_DIR ?? null,
	})}\n`,
);
