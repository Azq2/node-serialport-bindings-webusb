import type { WebUSBPortBinding } from '../src/index.js';
import { getUSBSerialDriverType } from '../src/drivers/registry.js';

const STREAM_PATTERN = Uint8Array.from(
	{ length: 256 },
	(_, index) => (index * 37 + 0x5A) & 0xFF,
);
const STRESS_PHASE_SECONDS = 10;
const SMALL_WRITE_MAX_SIZE = 256;
const SMALL_WINDOW_SIZE = 64 * 1024;
const LARGE_WRITE_MIN_POWER = 16;
const LARGE_WRITE_MAX_POWER = 19;
const LARGE_WINDOW_SIZE = 64 * 1024;

type LoopbackBinding = Pick<WebUSBPortBinding, 'read' | 'write' | 'set'>;

export interface StressLoopbackPhaseResult {
	bytes: number;
	writes: number;
	elapsedSeconds: number;
}

export interface StressLoopbackResult {
	small: StressLoopbackPhaseResult;
	large: StressLoopbackPhaseResult;
}

export function loopbackBaudRates(device: USBDevice): readonly number[] {
	switch (getUSBSerialDriverType(device)) {
		case 'ftdi': return [115200, 3_000_000];
		case 'cp210x': return [115200, 1_000_000];
		case 'ch341': return [115200, 1_500_000];
		case 'pl2303': return [115200, 1_228_800];
		default: return [115200, 921600];
	}
}

function pattern(offset: number, length: number): Buffer {
	const result = Buffer.allocUnsafe(length);
	for (let index = 0; index < length; index++)
		result[index] = STREAM_PATTERN[(offset + index) & 0xFF];
	return result;
}

async function readExact(binding: LoopbackBinding, length: number): Promise<Buffer> {
	const result = Buffer.allocUnsafe(length);
	let offset = 0;
	while (offset < length) {
		const read = await binding.read(result, offset, length - offset);
		if (read.bytesRead === 0)
			throw new Error(`Loopback read ended after ${offset} of ${length} bytes`);
		offset += read.bytesRead;
	}
	return result;
}

async function exchange(binding: LoopbackBinding, payload: Buffer): Promise<void> {
	const [received] = await Promise.all([
		readExact(binding, payload.length),
		binding.write(payload),
	]);
	if (!received.equals(payload)) {
		const mismatch = received.findIndex((value, index) => value !== payload[index]);
		throw new Error(
			`Loopback data mismatch at offset ${mismatch}: ` +
			`got 0x${received[mismatch].toString(16)}, expected 0x${payload[mismatch].toString(16)}`,
		);
	}
}

async function prepareLoopback(binding: LoopbackBinding): Promise<void> {
	await binding.set({ dtr: false, rts: false });
	await binding.set({ dtr: true, rts: true });
}

async function runLoopback(binding: LoopbackBinding): Promise<void> {
	for (const length of [1, 9, 63, 64, 65, 255, 256, 257, 1024])
		await exchange(binding, pattern(length, length));
}

async function runStressLoopbackPhase(
	binding: LoopbackBinding,
	windowSize: number,
	nextWriteSize: () => number,
): Promise<StressLoopbackPhaseResult> {
	const started = performance.now();
	let bytes = 0;
	let writes = 0;
	do {
		const payload = pattern(bytes, windowSize);
		const reader = readExact(binding, payload.length);
		let offset = 0;
		while (offset < payload.length) {
			const writeSize = Math.min(nextWriteSize(), payload.length - offset);
			await binding.write(payload.subarray(offset, offset + writeSize));
			offset += writeSize;
			writes++;
		}
		const received = await reader;
		if (!received.equals(payload)) {
			const mismatch = received.findIndex((value, index) => value !== payload[index]);
			throw new Error(`Stress loopback data mismatch at offset ${bytes + mismatch}`);
		}
		bytes += payload.length;
	} while (performance.now() - started < STRESS_PHASE_SECONDS * 1000);
	return { bytes, writes, elapsedSeconds: (performance.now() - started) / 1000 };
}

function createRandom(): () => number {
	let state = 0x12345678;
	return () => {
		state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
		return state;
	};
}

function runSmallStressLoopback(binding: LoopbackBinding): Promise<StressLoopbackPhaseResult> {
	const random = createRandom();
	return runStressLoopbackPhase(
		binding,
		SMALL_WINDOW_SIZE,
		() => 1 + random() % SMALL_WRITE_MAX_SIZE,
	);
}

function runLargeStressLoopback(binding: LoopbackBinding): Promise<StressLoopbackPhaseResult> {
	const random = createRandom();
	return runStressLoopbackPhase(binding, LARGE_WINDOW_SIZE, () => {
		const power = LARGE_WRITE_MIN_POWER + random() % (LARGE_WRITE_MAX_POWER - LARGE_WRITE_MIN_POWER + 1);
		const lowerBound = 2 ** (power - 1);
		return lowerBound + random() % lowerBound;
	});
}

async function runStressLoopback(binding: LoopbackBinding): Promise<StressLoopbackResult> {
	const small = await runSmallStressLoopback(binding);
	const large = await runLargeStressLoopback(binding);
	return { small, large };
}

export async function runLoopbackSuite(
	binding: LoopbackBinding,
): Promise<void> {
	await prepareLoopback(binding);
	await runLoopback(binding);
}

export async function runStressLoopbackSuite(binding: LoopbackBinding): Promise<StressLoopbackResult> {
	await runLoopbackSuite(binding);
	return runStressLoopback(binding);
}
