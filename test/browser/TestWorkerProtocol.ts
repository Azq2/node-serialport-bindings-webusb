import type { StressLoopbackResult } from '../Loopback.js';
import type { BFCResult } from '../PhoneTests.js';
import type { USBSerialDeviceKind } from '../USBSerialDevice.js';

interface TestWorkerOptions {
	path: string;
	emulatorKind?: USBSerialDeviceKind;
}

export type TestWorkerCommand = TestWorkerOptions & (
	{ type: 'loopback', baudRate: number } |
	{ type: 'stress-loopback', baudRate: number } |
	{ type: 'at' } |
	{ type: 'bfc' } |
	{ type: 'chaos' }
);

export type TestWorkerReply =
	{ type: 'loopback' } |
	{ type: 'stress-loopback', result: StressLoopbackResult } |
	{ type: 'at', statuses: string[] } |
	{ type: 'bfc', result: BFCResult } |
	{ type: 'chaos', bytesRead: number, distinctBytes: number };

export interface TestWorkerError {
	name: string;
	message: string;
	stack?: string;
	cause?: unknown;
}

export type TestWorkerResponse =
	{ type: 'progress', bytesRead: number } |
	{ type: 'stage', stage: string } |
	{ type: 'result', result: TestWorkerReply } |
	{ type: 'error', error: TestWorkerError };

function cloneError(value: unknown): unknown {
	if (value instanceof Error || value instanceof DOMException) {
		return {
			name: value.name,
			message: value.message,
			stack: value.stack,
			cause: cloneError(value.cause),
		};
	}
	if (typeof value === 'object' && value !== null && 'status' in value) {
		return {
			status: value.status,
			data: 'data' in value ? value.data : undefined,
			bytesWritten: 'bytesWritten' in value ? value.bytesWritten : undefined,
		};
	}
	return value;
}

export function serializeWorkerError(value: unknown): TestWorkerError {
	if (value instanceof Error || value instanceof DOMException) {
		return {
			name: value.name,
			message: value.message,
			stack: value.stack,
			cause: cloneError(value.cause),
		};
	}
	return { name: 'Error', message: String(value), cause: cloneError(value) };
}

export function restoreWorkerError(value: TestWorkerError): Error {
	const error = new Error(value.message, { cause: value.cause });
	error.name = value.name;
	error.stack = value.stack;
	return error;
}
