import { WebUSBError } from '../WebUSBError.js';

const MAX_PENDING_TRANSFERS = 64;

interface PendingTransfer {
	chunk: Uint8Array;
	transfer: Promise<USBOutTransferResult>;
}

async function checkTransfer(name: string, { chunk, transfer }: PendingTransfer): Promise<void> {
	const result = await transfer;
	if (result.status === 'stall')
		throw new WebUSBError(`${name} bulk-out endpoint stalled`, { cause: result });
	if (result.status !== 'ok')
		throw new WebUSBError(`${name} bulk-out transfer failed with status ${result.status}`, { cause: result });
	if (result.bytesWritten !== chunk.byteLength) {
		throw new WebUSBError(
			`${name} bulk-out transfer wrote ${result.bytesWritten} of ${chunk.byteLength} bytes`,
			{ cause: result },
		);
	}
}

export async function transferOutChunks(
	device: USBDevice,
	endpoint: number,
	chunks: Iterable<Uint8Array<ArrayBuffer>>,
	name: string,
): Promise<void> {
	const pending: PendingTransfer[] = [];
	for (const chunk of chunks) {
		if (pending.length >= MAX_PENDING_TRANSFERS)
			await checkTransfer(name, pending.shift()!);
		const transfer = device.transferOut(endpoint, chunk);
		transfer.catch(() => undefined);
		pending.push({ chunk, transfer });
	}
	while (pending.length > 0)
		await checkTransfer(name, pending.shift()!);
}
