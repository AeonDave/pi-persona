/** Bounded-concurrency job queue. Handlers receive an AbortSignal and should honour it. */
export class JobQueue {
	#pending = [];
	#running = new Map();
	#results = new Map();
	#concurrency;

	constructor({ concurrency = 2 } = {}) {
		this.#concurrency = concurrency;
	}

	submit(id, handler) {
		if (this.#results.has(id) || this.#running.has(id)) throw new Error(`duplicate job: ${id}`);
		this.#pending.push({ id, handler });
		this.#results.set(id, { status: "pending" });
		this.#drain();
		return id;
	}

	status(id) {
		return this.#results.get(id)?.status ?? "unknown";
	}

	cancel(id) {
		const index = this.#pending.findIndex((job) => job.id === id);
		if (index >= 0) {
			this.#pending.splice(index, 1);
			this.#results.set(id, { status: "cancelled" });
			return true;
		}
		return false;
	}

	#drain() {
		while (this.#running.size < this.#concurrency && this.#pending.length > 0) {
			const job = this.#pending.shift();
			const controller = new AbortController();
			this.#running.set(job.id, controller);
			this.#results.set(job.id, { status: "running" });
			Promise.resolve()
				.then(() => job.handler(controller.signal))
				.then(
					(value) => this.#settle(job.id, { status: "done", value }),
					(error) => this.#settle(job.id, { status: "failed", error }),
				);
		}
	}

	#settle(id, result) {
		if (!this.#running.delete(id)) return;
		this.#results.set(id, result);
		this.#drain();
	}
}
