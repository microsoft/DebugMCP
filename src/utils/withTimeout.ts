// Copyright (c) Microsoft Corporation.

/**
 * Race a promise against a timeout so a hung operation can't block forever.
 *
 * Resolves/rejects with `work`'s outcome if it settles within `timeoutMs`;
 * otherwise rejects with the Error from `onTimeout()`. The timer is always
 * cleared so a slow-but-eventual `work` doesn't leak a pending timer or a
 * late rejection. Note: `work` itself is not cancelled — this only bounds how
 * long the caller waits.
 */
export async function withTimeout<T>(
	work: Promise<T>,
	timeoutMs: number,
	onTimeout: () => Error
): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(onTimeout()), timeoutMs);
	});
	try {
		return await Promise.race([work, timeout]);
	} finally {
		if (timer) {
			clearTimeout(timer);
		}
	}
}
