import type { WebUSBPortBinding } from '../src/index.js';

export const INFINEON_BOOT_DEVICE = { vendorId: 0x058B, productId: 0x0015 } as const;

const AT_REQUEST = 'ATAT';
const AT_REPLY_TIMEOUT_MS = 20;
const HANDSHAKE_TIMEOUT_MS = 2000;
const COMMAND_TIMEOUT_MS = 3000;
const DWD_HANDSHAKE = 0x0B;
const BOOT_INFO_SIZE = 0x4C;
const FLASH_INFO_SIZE = 256;
const COMMAND_CHECKSUM_ERROR = 0x0001;
const COMMAND_FLASH_INFO = 0x0084;
const COMMAND_STOP_TIMEOUT = 0x0102;
const FRAME_START = 2;
const FRAME_END = 3;

export interface BootcoreResult {
	bootInfo: string;
	flashInfo: string;
	stopTimeout?: string;
}

type BootBinding = Pick<WebUSBPortBinding, 'read' | 'write'>;

function hex(data: Uint8Array): string {
	return Array.from(data, byte => byte.toString(16).padStart(2, '0')).join(' ');
}

function delay(ms: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, ms));
}

function timeout(ms: number, message: string): { promise: Promise<never>, cancel(): void } {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const promise = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new Error(message)), ms);
	});
	return { promise, cancel: () => clearTimeout(timer) };
}

class BootReader {
	private pending = Buffer.alloc(0);
	private reading?: Promise<void>;

	constructor(private readonly binding: BootBinding) {}

	get buffered(): number {
		return this.pending.length;
	}

	fill(): Promise<void> {
		this.reading ??= this.binding.read(Buffer.alloc(4096), 0, 4096).then(({ buffer, bytesRead }) => {
			this.pending = Buffer.concat([this.pending, buffer.subarray(0, bytesRead)]);
		}).finally(() => {
			this.reading = undefined;
		});
		return this.reading;
	}

	async readExact(length: number, timeoutMs: number, what: string): Promise<Buffer> {
		const deadline = timeout(timeoutMs, `Timed out waiting for ${what}: ${this.pending.length}/${length} bytes`);
		try {
			while (this.pending.length < length)
				await Promise.race([this.fill(), deadline.promise]);
		} finally {
			deadline.cancel();
		}
		return this.take(length);
	}

	take(length: number): Buffer {
		const result = this.pending.subarray(0, length);
		this.pending = this.pending.subarray(length);
		return result;
	}
}

function encodeFrame(command: number, payload = new Uint8Array(0)): Buffer {
	const frame = Buffer.alloc(payload.length + 10);
	const checksum = payload.reduce((sum, byte) => sum + byte, command + payload.length) & 0xFFFF;
	frame.writeUInt16LE(FRAME_START, 0);
	frame.writeUInt16LE(command, 2);
	frame.writeUInt16LE(payload.length, 4);
	frame.set(payload, 6);
	frame.writeUInt16LE(checksum, 6 + payload.length);
	frame.writeUInt16LE(FRAME_END, 8 + payload.length);
	return frame;
}

async function request(binding: BootBinding, reader: BootReader, command: number): Promise<Buffer> {
	const name = `command ${command.toString(16).padStart(4, '0')}`;
	await binding.write(encodeFrame(command));
	const header = await reader.readExact(6, COMMAND_TIMEOUT_MS, `${name} header`);
	const start = header.readUInt16LE(0);
	const replyCommand = header.readUInt16LE(2);
	const size = header.readUInt16LE(4);
	if (start !== FRAME_START)
		throw new Error(`${name}: invalid frame start ${hex(header)}`);
	const body = await reader.readExact(size + 4, COMMAND_TIMEOUT_MS, `${name} body`);
	const payload = body.subarray(0, size);
	const checksum = body.readUInt16LE(size);
	const end = body.readUInt16LE(size + 2);
	const expectedChecksum = payload.reduce((sum, byte) => sum + byte, replyCommand + size) & 0xFFFF;
	if (end !== FRAME_END || checksum !== expectedChecksum)
		throw new Error(`${name}: invalid frame ${hex(header)} ${hex(body)}`);
	if (replyCommand === COMMAND_CHECKSUM_ERROR)
		throw new Error(`${name}: loader rejected the request checksum: ${hex(payload)}`);
	if (replyCommand !== command)
		throw new Error(`${name}: unexpected response command ${replyCommand.toString(16)}`);
	return payload;
}

async function handshake(binding: BootBinding, reader: BootReader): Promise<number> {
	const at = Buffer.from(AT_REQUEST);
	const started = performance.now();
	let replied = false;
	let failure: unknown;
	const reply = reader.fill().then(() => { replied = true; }, error => { failure = error; });
	while (!replied) {
		if (failure)
			throw failure;
		if (performance.now() - started > HANDSHAKE_TIMEOUT_MS)
			throw new Error(`No reply to ${AT_REQUEST}`);
		await binding.write(at);
		await Promise.race([reply, delay(AT_REPLY_TIMEOUT_MS)]);
	}
	return reader.take(1)[0];
}

export async function readBootcoreInfo(binding: BootBinding, stopTimeout: boolean): Promise<BootcoreResult> {
	const reader = new BootReader(binding);
	const reply = await handshake(binding, reader);
	if (reply !== DWD_HANDSHAKE)
		throw new Error(`Expected bootcore handshake 0b, got ${reply.toString(16).padStart(2, '0')}`);
	const bootInfo = await reader.readExact(BOOT_INFO_SIZE, COMMAND_TIMEOUT_MS, 'boot information');
	const mode = bootInfo.readUInt32LE(0);
	if (mode !== 0xBB && mode !== 0xCC)
		throw new Error(`Invalid boot information: ${hex(bootInfo)}`);
	const flashInfo = await request(binding, reader, COMMAND_FLASH_INFO);
	if (flashInfo.length !== FLASH_INFO_SIZE)
		throw new Error(`Flash information has ${flashInfo.length} bytes, expected ${FLASH_INFO_SIZE}`);
	const result: BootcoreResult = { bootInfo: hex(bootInfo), flashInfo: hex(flashInfo) };
	if (stopTimeout)
		result.stopTimeout = hex(await request(binding, reader, COMMAND_STOP_TIMEOUT));
	if (reader.buffered)
		throw new Error(`Unexpected trailing bytes: ${reader.buffered}`);
	return result;
}
