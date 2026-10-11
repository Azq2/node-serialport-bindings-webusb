import createDebug from 'debug';
import type { PortStatus, SetOptions } from '@serialport/bindings-interface' with { 'resolution-mode': 'require' };
import { WebUSBError } from '../../WebUSBError.js';
import {
	BulkSerialDriver,
	findBulkInterfaceNumbers,
	selectBulkPort,
	webUSBBytes,
	type BulkSerialPort,
} from '../BulkSerial/BulkSerialDriver.js';
import type { USBSerialDeviceInfo, USBSerialOpenOptions } from '../types.js';
import { CP210X_DEVICES } from './devices.js';

const debug = createDebug('serialport/bindings-webusb/cp210x');

const IFC_ENABLE = 0x00;
const SET_LINE_CTL = 0x03;
const SET_BREAK = 0x05;
const SET_MHS = 0x07;
const GET_MDMSTS = 0x08;
const PURGE = 0x12;
const SET_FLOW = 0x13;
const GET_FLOW = 0x14;
const SET_CHARS = 0x19;
const SET_BAUDRATE = 0x1E;
const VENDOR_SPECIFIC = 0xFF;
const GET_PARTNUM = 0x370B;
const GET_FW_VER_2N = 0x0010;
const UART_ENABLE = 1;
const CONTROL_DTR = 0x0001;
const CONTROL_RTS = 0x0002;
const CONTROL_CTS = 0x0010;
const CONTROL_DSR = 0x0020;
const CONTROL_DCD = 0x0080;
const CONTROL_WRITE_DTR = 0x0100;
const CONTROL_WRITE_RTS = 0x0200;
const SERIAL_CTS_HANDSHAKE = 1 << 3;
const SERIAL_DTR_MASK = 0x03;
const SERIAL_DTR_ACTIVE = 1;
const SERIAL_RTS_MASK = 0xC0;
const SERIAL_RTS_ACTIVE = 1 << 6;
const SERIAL_RTS_FLOW_CONTROL = 2 << 6;
const SERIAL_AUTO_TRANSMIT = 1;
const SERIAL_AUTO_RECEIVE = 2;

const AN205_RATES: readonly [rate: number, high: number][] = [
	[300, 300], [600, 600], [1200, 1200], [1800, 1800], [2400, 2400], [4000, 4000], [4800, 4803],
	[7200, 7207], [9600, 9612], [14400, 14428], [16000, 16062], [19200, 19250], [28800, 28912],
	[38400, 38601], [51200, 51558], [56000, 56280], [57600, 58053], [64000, 64111], [76800, 77608],
	[115200, 117028], [128000, 129347], [153600, 156868], [230400, 237832], [250000, 254234],
	[256000, 273066], [460800, 491520], [500000, 567138], [576000, 670254], [921600, Number.MAX_SAFE_INTEGER],
];

function dataViewBytes(result: USBInTransferResult, length: number, operation: string): Uint8Array {
	if (result.status !== 'ok' || !result.data || result.data.byteLength !== length)
		throw new WebUSBError(`${operation} failed`, { cause: result });
	return new Uint8Array(result.data.buffer, result.data.byteOffset, result.data.byteLength);
}

function readUint32LE(data: Uint8Array, offset: number): number {
	return new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(offset, true);
}

function writeUint32LE(data: Uint8Array, offset: number, value: number): void {
	new DataView(data.buffer, data.byteOffset, data.byteLength).setUint32(offset, value, true);
}

export function normalizeCP210xBaudRate(requested: number, partNumber = 2, interfaceNumber = 0): number {
	let minimum = 300;
	let maximum = 2_000_000;
	let useActualRate = false;
	if (partNumber === 1) {
		maximum = 921600;
	} else if (partNumber === 2 || partNumber === 3) {
		maximum = 1_000_000;
	} else if (partNumber === 4) {
		useActualRate = true;
	} else if (partNumber === 5) {
		if (interfaceNumber === 0) {
			useActualRate = true;
		} else {
			minimum = 2400;
			maximum = 921600;
		}
	} else if (partNumber === 0x20 || partNumber === 0x21 || partNumber === 0x22) {
		maximum = 3_000_000;
		useActualRate = true;
	}
	const baudRate = Math.min(maximum, Math.max(minimum, requested));
	if (useActualRate) {
		const prescaler = baudRate <= 365 ? 4 : 1;
		const divisor = Math.round(48_000_000 / (2 * prescaler * baudRate));
		return Math.floor(48_000_000 / (2 * prescaler * divisor));
	}
	if (baudRate < 1_000_000)
		return AN205_RATES.find(([, high]) => baudRate <= high)?.[0] ?? 921600;
	return baudRate;
}

function encodeLineControl(options: USBSerialOpenOptions): number {
	let value = options.dataBits << 8;
	const parity = { none: 0, odd: 1, even: 2, mark: 3, space: 4 }[options.parity];
	value |= parity << 4;
	if (options.stopBits === 2)
		value |= 2;
	return value;
}

export class CP210xDriver extends BulkSerialDriver {
	static readonly supportedDevices: readonly USBSerialDeviceInfo[] = CP210X_DEVICES;

	static getInterfaceNumbers(device: USBDevice): readonly number[] {
		return findBulkInterfaceNumbers(device);
	}

	private partNumber = 0xFF;
	private dtr = true;
	private rts = true;
	private hardwareFlowControl = false;
	private noFlowControl = false;

	protected get bulkReadLength(): number {
		return 256;
	}

	protected get bulkWriteLength(): number {
		return 256;
	}

	protected selectPort(): BulkSerialPort {
		return selectBulkPort(this.device, this.requestedInterfaceNumber);
	}

	protected async initialize(options: USBSerialOpenOptions): Promise<number> {
		const part = await this.device.controlTransferIn({
			requestType: 'vendor', recipient: 'device', request: VENDOR_SPECIFIC, value: GET_PARTNUM,
			index: this.requirePort().controlInterfaceNumber,
		}, 1);
		if (part.status === 'ok' && part.data?.byteLength === 1)
			this.partNumber = part.data.getUint8(0);
		if (this.partNumber === 0x20 || this.partNumber === 0x21 || this.partNumber === 0x22)
			await this.detectFlowControlQuirk();
		await this.writeValue(IFC_ENABLE, UART_ENABLE);
		const baudRate = await this.configure(options);
		if (debug.enabled)
			debug('part 0x%s at %d baud', this.partNumber.toString(16), baudRate);
		return baudRate;
	}

	protected async configure(options: USBSerialOpenOptions): Promise<number> {
		if (this.partNumber === 1) {
			options.dataBits = 8;
			options.stopBits = 1;
			if (options.parity === 'mark')
				options.parity = 'odd';
			else if (options.parity === 'space')
				options.parity = 'even';
		}
		const baudRate = normalizeCP210xBaudRate(
			options.baudRate, this.partNumber, this.requirePort().controlInterfaceNumber,
		);
		const encodedBaud = new Uint8Array(4);
		writeUint32LE(encodedBaud, 0, baudRate);
		await this.writeBlock(SET_BAUDRATE, encodedBaud);
		await this.writeValue(SET_LINE_CTL, encodeLineControl(options));
		await this.configureFlowControl(options);
		return baudRate;
	}

	protected async setSignals(options: SetOptions): Promise<void> {
		let control = 0;
		if (options.dtr !== undefined) {
			this.dtr = options.dtr;
			control |= CONTROL_WRITE_DTR;
			if (options.dtr)
				control |= CONTROL_DTR;
		}
		if (options.rts !== undefined) {
			this.rts = options.rts;
			control |= CONTROL_WRITE_RTS;
			if (options.rts)
				control |= CONTROL_RTS;
		}
		if (control) {
			if (this.hardwareFlowControl && options.rts !== undefined)
				await this.updateFlowSignals();
			else
				await this.writeValue(SET_MHS, control);
		}
		if (options.brk !== undefined)
			await this.writeValue(SET_BREAK, options.brk ? 1 : 0);
	}

	protected async readStatus(): Promise<PortStatus> {
		const result = dataViewBytes(await this.readBlock(GET_MDMSTS, 1), 1, 'CP210x modem-status request')[0];
		return {
			cts: Boolean(result & CONTROL_CTS),
			dsr: Boolean(result & CONTROL_DSR),
			dcd: Boolean(result & CONTROL_DCD),
		};
	}

	protected async shutdown(): Promise<void> {
		await this.writeValue(PURGE, 0x000F);
		await this.writeValue(IFC_ENABLE, 0);
	}

	private async configureFlowControl(options: USBSerialOpenOptions): Promise<void> {
		if (this.noFlowControl) {
			options.rtscts = false;
			options.xon = false;
			options.xoff = false;
		}
		if (options.xon || options.xoff)
			await this.writeBlock(SET_CHARS, new Uint8Array([0, 0, 0, 0, 0x11, 0x13]));
		const flow = dataViewBytes(await this.readBlock(GET_FLOW, 16), 16, 'CP210x flow-control request');
		let handshake = readUint32LE(flow, 0);
		let replacement = readUint32LE(flow, 4);
		handshake &= ~(SERIAL_DTR_MASK | SERIAL_CTS_HANDSHAKE | 0x70);
		handshake |= this.dtr ? SERIAL_DTR_ACTIVE : 0;
		replacement &= ~(SERIAL_RTS_MASK | SERIAL_AUTO_TRANSMIT | SERIAL_AUTO_RECEIVE);
		if (options.rtscts) {
			handshake |= SERIAL_CTS_HANDSHAKE;
			replacement |= this.rts ? SERIAL_RTS_FLOW_CONTROL : 0;
		} else if (this.rts) {
			replacement |= SERIAL_RTS_ACTIVE;
		}
		if (options.xon)
			replacement |= SERIAL_AUTO_TRANSMIT;
		if (options.xoff)
			replacement |= SERIAL_AUTO_RECEIVE;
		writeUint32LE(flow, 0, handshake);
		writeUint32LE(flow, 4, replacement);
		writeUint32LE(flow, 8, options.xoff ? 128 : readUint32LE(flow, 8));
		writeUint32LE(flow, 12, options.xoff ? 128 : readUint32LE(flow, 12));
		await this.writeBlock(SET_FLOW, flow);
		this.hardwareFlowControl = options.rtscts;
	}

	private async detectFlowControlQuirk(): Promise<void> {
		const result = await this.device.controlTransferIn({
			requestType: 'vendor', recipient: 'device', request: VENDOR_SPECIFIC, value: GET_FW_VER_2N,
			index: this.requirePort().controlInterfaceNumber,
		}, 3);
		if (result.status !== 'ok' || !result.data || result.data.byteLength !== 3)
			return;
		const version = result.data.getUint8(0) << 16 | result.data.getUint8(1) << 8 | result.data.getUint8(2);
		this.noFlowControl = version <= 0x010004;
	}

	private async updateFlowSignals(): Promise<void> {
		const flow = dataViewBytes(await this.readBlock(GET_FLOW, 16), 16, 'CP210x flow-control request');
		let handshake = readUint32LE(flow, 0) & ~SERIAL_DTR_MASK;
		let replacement = readUint32LE(flow, 4) & ~SERIAL_RTS_MASK;
		if (this.dtr)
			handshake |= SERIAL_DTR_ACTIVE;
		if (this.rts)
			replacement |= SERIAL_RTS_FLOW_CONTROL;
		writeUint32LE(flow, 0, handshake);
		writeUint32LE(flow, 4, replacement);
		await this.writeBlock(SET_FLOW, flow);
	}

	private readBlock(request: number, length: number): Promise<USBInTransferResult> {
		return this.device.controlTransferIn({
			requestType: 'vendor', recipient: 'interface', request, value: 0,
			index: this.requirePort().controlInterfaceNumber,
		}, length);
	}

	private async writeValue(request: number, value: number): Promise<void> {
		await this.writeRequest(request, value);
	}

	private async writeBlock(request: number, data: Uint8Array): Promise<void> {
		await this.writeRequest(request, 0, data);
	}

	private async writeRequest(request: number, value: number, data?: Uint8Array): Promise<void> {
		const result = await this.device.controlTransferOut({
			requestType: 'vendor', recipient: 'interface', request, value,
			index: this.requirePort().controlInterfaceNumber,
		}, data ? webUSBBytes(data) : undefined);
		if (result.status !== 'ok' || result.bytesWritten !== (data?.byteLength ?? 0))
			throw new WebUSBError(`CP210x request 0x${request.toString(16)} failed`, { cause: result });
	}
}
