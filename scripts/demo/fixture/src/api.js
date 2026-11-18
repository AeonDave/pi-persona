import { JobQueue } from "./queue.js";

/**
 * Public surface used by the HTTP routes. Contract: `cancel` resolves `true` when the job will
 * not complete, whether it was still pending or already running.
 */
export function createApi({ concurrency } = {}) {
	const queue = new JobQueue({ concurrency });
	return {
		submit: (id, handler) => queue.submit(id, handler),
		status: (id) => queue.status(id),
		cancel: (id) => queue.cancel(id),
	};
}
