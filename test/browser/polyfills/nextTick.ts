export function nextTick<Args extends unknown[]>(callback: (...args: Args) => void, ...args: Args): void;
export function nextTick(
	callback: (...args: unknown[]) => void,
	arg1?: unknown,
	arg2?: unknown,
	arg3?: unknown,
	arg4?: unknown,
): void {
	let run: () => void;
	switch (arguments.length) {
		case 1:
			run = callback;
			break;
		case 2:
			run = () => { callback(arg1); };
			break;
		case 3:
			run = () => { callback(arg1, arg2); };
			break;
		case 4:
			run = () => { callback(arg1, arg2, arg3); };
			break;
		case 5:
			run = () => { callback(arg1, arg2, arg3, arg4); };
			break;
		default: {
			const args = Array.prototype.slice.call(arguments, 1) as unknown[];
			run = () => { callback(...args); };
		}
	}
	if (typeof globalThis.queueMicrotask === 'function') {
		globalThis.queueMicrotask(run);
	} else {
		void Promise.resolve().then(run).catch(error => {
			// Match a thrown callback error, not an unhandled Promise rejection.
			if (typeof globalThis.reportError === 'function') {
				globalThis.reportError(error);
			} else {
				globalThis.setTimeout(() => { throw error; }, 0);
			}
		});
	}
}
