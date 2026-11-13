// Online CI preparation only: the integration test itself keeps PI_OFFLINE=1.
// Use Pi's pinned SDK downloader, not a second installer or a developer's private profile.
import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

assert.ok(process.env.GITHUB_PATH, "GITHUB_PATH must identify the file receiving the prepared tools' PATH entry");
const agentDir = await mkdtemp(join(tmpdir(), "pi-persona-native-prerequisites-"));
try {
	// The helper is shipped with Pi 1.5.2 but is not re-exported by its public entry.
	const sdkEntry = import.meta.resolve("@earendil-works/pi-coding-agent");
	const { ENV_AGENT_DIR, getBinDir } = await import(new URL("./config.js", sdkEntry));
	process.env[ENV_AGENT_DIR] = agentDir;
	assert.equal(getBinDir(), join(agentDir, "bin"));
	// Import only after setting the SDK's actual override: tools-manager captures its bin dir.
	const { ensureTool } = await import(new URL("./utils/tools-manager.js", sdkEntry));
	const { createBashTool } = await import("@earendil-works/pi-coding-agent");
	const bash = createBashTool(agentDir);
	for (const name of ["rg", "fd"]) {
		const path = await ensureTool(name, ({ type, message }) => console.log(`${type}: ${message}`));
		assert.ok(path, `Pi could not prepare the real ${name} binary`);
		const quoted = `'${path.replaceAll("\\", "/").replaceAll("'", "'\\''")}'`;
		const result = await bash.execute(`prepare-${name}`, { command: `${quoted} --version`, timeout: 15 }, new AbortController().signal);
		assert.equal(result.structuredContent?.exit_code, 0, JSON.stringify(result));
		console.log(result.structuredContent.output.trim());
	}
	const binDir = join(agentDir, "bin");
	await mkdir(binDir, { recursive: true });
	await appendFile(process.env.GITHUB_PATH, `${binDir}\n`);
	console.log(`Native test tools PATH entry: ${binDir}`);
} catch (error) {
	await rm(agentDir, { recursive: true, force: true });
	throw error;
}
