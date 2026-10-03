import { TelemetryProducer } from "../../src/telemetry/producer.ts";

const [agentDir, cwd, sessionId] = process.argv.slice(2);
const producer = new TelemetryProducer({ agentDir, cwd, sessionId, heartbeatMs: 0, retentionMs: 0, emit: () => {} });
producer.publish("instance.heartbeat", { contextPercent: 1 });
await producer.flush();
process.send({ type: "READY", file: producer.filePath });
process.once("message", async (message) => {
	if (message !== "stop") throw new Error("unexpected IPC control message");
	await producer.stop();
	process.send({ type: "STOPPED" }, () => process.disconnect());
});
