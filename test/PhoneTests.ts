import type { BindingInterface } from '@serialport/bindings-interface' with { 'resolution-mode': 'require' };
import { AsyncSerialPort, AtChannel, BFC, ChaosLoader } from '@sie-js/serial';

const FLASH_ADDRESS = 0xA0000000;
const FLASH_SIZE = 1024 * 1024;
const AT_COMMANDS = [
	'AT',
	'ATI',
	'AT+CGMI',
	'AT+CGMM',
	'AT+CGMR',
	'AT+CGSN',
	'AT+CSQ',
	'AT+CBC',
];

function randomCommands(): string[] {
	return AT_COMMANDS
		.map(command => ({ command, order: Math.random() }))
		.sort((a, b) => a.order - b.order)
		.map(item => item.command);
}

async function disconnect(
	connected: boolean,
	close: () => Promise<void>,
	failure?: unknown,
): Promise<void> {
	if (!connected)
		return;
	try {
		await close();
	} catch (error) {
		if (failure !== undefined)
			throw new AggregateError([failure, error], 'Phone operation and disconnect failed');
		throw error;
	}
}

export async function exchangeAT<T extends BindingInterface>(port: AsyncSerialPort<T>): Promise<string[]> {
	const at = new AtChannel(port);
	const statuses: string[] = [];
	at.start();
	try {
		for (const command of randomCommands()) {
			const response = await at.sendCommandNoPrefixAll(command, 5000);
			if (!/^(?:OK|ERROR|\+CME ERROR|\+CMS ERROR)/.test(response.status))
				throw new Error(`${command} did not receive a terminal response: ${response.status}`);
			statuses.push(response.status);
		}
		return statuses;
	} finally {
		at.stop();
	}
}

export interface BFCResult {
	bytesRead: number;
	distinctBytes: number;
	baudRate: number;
	sha256: string;
}

export async function readBFC<T extends BindingInterface>(
	port: AsyncSerialPort<T>,
	onProgress?: (bytesRead: number) => void,
): Promise<BFCResult> {
	const bfc = new BFC(port);
	let connected = false;
	let bytesRead = 0;
	let failure: unknown;
	try {
		await bfc.connect();
		connected = true;
		if (!await bfc.setBestBaudrate())
			throw new Error('BFC did not accept a supported baud rate');
		const result = await bfc.readMemory(FLASH_ADDRESS, FLASH_SIZE, {
			onProgress(progress) {
				bytesRead = progress.cursor;
				onProgress?.(bytesRead);
			},
		});
		const bytes = result.buffer;
		const digestInput = bytes.buffer instanceof ArrayBuffer ?
			new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength) :
			Uint8Array.from(bytes);
		const digest = await crypto.subtle.digest('SHA-256', digestInput);
		return {
			bytesRead: result.buffer.length,
			distinctBytes: new Set(result.buffer).size,
			baudRate: port.baudRate,
			sha256: Buffer.from(digest).toString('hex'),
		};
	} catch (error) {
		failure = new Error(
			`BFC flash read failed at ${port.baudRate} baud after ${bytesRead} bytes`,
			{ cause: error },
		);
		throw failure;
	} finally {
		await disconnect(connected, () => bfc.disconnect(), failure);
	}
}

export interface ChaosProgress {
	percent: number;
	speed: number;
	remaining: number;
}

export async function readChaosMemory<T extends BindingInterface>(
	port: AsyncSerialPort<T>,
	address: number,
	size: number,
	baudRate: number,
	onProgress?: (progress: ChaosProgress) => void,
): Promise<Buffer> {
	const chaos = new ChaosLoader(port);
	let connected = false;
	let failure: unknown;
	try {
		await chaos.connect();
		connected = true;
		await chaos.activate();
		await chaos.ping();
		await chaos.setSpeed(baudRate);
		await chaos.ping();
		const result = await chaos.readMemory(address, size, { onProgress });
		return result.buffer;
	} catch (error) {
		failure = error;
		throw error;
	} finally {
		await disconnect(connected, () => chaos.disconnect(), failure);
	}
}
