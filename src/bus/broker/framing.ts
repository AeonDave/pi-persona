/**
 * Length-prefixed JSON framing (ported from pi-subagents-comtac): a 4-byte big-endian
 * length header + a UTF-8 JSON payload. A reader accumulates chunks, emits complete frames
 * greedily, caps a single frame at 16 MiB (DoS guard), and POISONS itself on the first
 * error (oversize / bad JSON) — the caller destroys the socket. Pure, identical on all OSes.
 */

const MAX_FRAME_BYTES = 16 * 1024 * 1024;

export function encodeFrame(obj: unknown): Buffer {
	const body = Buffer.from(JSON.stringify(obj), "utf8");
	const head = Buffer.alloc(4);
	head.writeUInt32BE(body.length, 0);
	return Buffer.concat([head, body]);
}

export function createFrameReader(onFrame: (obj: unknown) => void, onError: (e: Error) => void): (chunk: Buffer) => void {
	let buf: Buffer = Buffer.alloc(0);
	let poisoned = false;
	return (chunk: Buffer): void => {
		if (poisoned) return;
		buf = buf.length === 0 ? chunk : Buffer.concat([buf, chunk]);
		for (;;) {
			if (buf.length < 4) return;
			const len = buf.readUInt32BE(0);
			if (len > MAX_FRAME_BYTES) {
				poisoned = true;
				onError(new Error(`broker frame too large (${len} bytes)`));
				return;
			}
			if (buf.length < 4 + len) return;
			const body = buf.subarray(4, 4 + len);
			buf = buf.subarray(4 + len);
			try {
				onFrame(JSON.parse(body.toString("utf8")));
			} catch (e) {
				poisoned = true;
				onError(e instanceof Error ? e : new Error(String(e)));
				return;
			}
		}
	};
}
