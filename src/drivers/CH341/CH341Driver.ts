import createDebug from 'debug';
import type { PortStatus, SetOptions } from '@serialport/bindings-interface' with { 'resolution-mode': 'require' };
import { WebUSBError } from '../../WebUSBError.js';
import {
	activeAlternate,
	BulkSerialDriver,
	findBulkInterfaceNumbers,
	selectBulkPort,
	type BulkSerialPort,
} from '../BulkSerial/BulkSerialDriver.js';
import type { USBSerialDeviceInfo, USBSerialOpenOptions } from '../types.js';

const debug = createDebug('serialport/bindings-webusb/ch341');

const REQUEST_READ_VERSION = 0x5F;
const REQUEST_WRITE_REG = 0x9A;
const REQUEST_READ_REG = 0x95;
const REQUEST_SERIAL_INIT = 0xA1;
const REQUEST_MODEM_CTRL = 0xA4;
const REG_BREAK = 0x05;
const REG_PRESCALER = 0x12;
const REG_DIVISOR = 0x13;
const REG_LCR = 0x18;
const REG_LCR2 = 0x25;
const REG_FLOW_CTL = 0x27;
const BIT_RTS = 1 << 6;
const BIT_DTR = 1 << 5;
const BIT_CTS = 1 << 0;
const BIT_DSR = 1 << 1;
const BIT_DCD = 1 << 3;
const LCR_ENABLE_RX = 0x80;
const LCR_ENABLE_TX = 0x40;
const LCR_MARK_SPACE = 0x20;
const LCR_PAR_EVEN = 0x10;
const LCR_ENABLE_PAR = 0x08;
const LCR_STOP_BITS_2 = 0x04;
const CLOCK_RATE = 48_000_000;
const MIN_BAUD_RATE = Math.ceil(CLOCK_RATE / ((1 << 12) * 256));
const MAX_BAUD_RATE = CLOCK_RATE / 16;

function bytes(result: USBInTransferResult, expected: number, operation: string): Uint8Array {
	if (result.status !== 'ok' || !result.data || result.data.byteLength !== expected)
		throw new WebUSBError(`${operation} failed`, { cause: result });
	return new Uint8Array(result.data.buffer, result.data.byteOffset, result.data.byteLength);
}

export function encodeCH341Divisor(requestedBaudRate: number, limitedPrescaler = false): number {
	const baudRate = Math.min(MAX_BAUD_RATE, Math.max(MIN_BAUD_RATE, requestedBaudRate));
	let factor = 1;
	let prescaler = 3;
	for (; prescaler >= 0; prescaler--) {
		const minimum = CLOCK_RATE / ((1 << (12 - 3 * prescaler - 1)) * 512);
		if (baudRate > minimum)
			break;
	}
	if (prescaler < 0)
		throw new WebUSBError(`Unsupported CH341 baud rate ${requestedBaudRate}`);
	let clockDivisor = 1 << (12 - 3 * prescaler - factor);
	let divisor = Math.floor(CLOCK_RATE / (clockDivisor * baudRate));
	if (divisor < 9 || divisor > 255 || (prescaler < 3 && limitedPrescaler)) {
		divisor = Math.floor(divisor / 2);
		clockDivisor *= 2;
		factor = 0;
	}
	if (divisor < 2)
		throw new WebUSBError(`Unsupported CH341 baud rate ${requestedBaudRate}`);
	const currentError = CLOCK_RATE / (clockDivisor * divisor) - baudRate;
	const nextError = baudRate - CLOCK_RATE / (clockDivisor * (divisor + 1));
	if (currentError >= nextError)
		divisor++;
	if (factor === 1 && divisor % 2 === 0) {
		divisor /= 2;
		factor = 0;
	}
	return (0x100 - divisor) << 8 | factor << 2 | prescaler;
}

function encodeLineControl(options: USBSerialOpenOptions): number {
	let value = LCR_ENABLE_RX | LCR_ENABLE_TX | (options.dataBits - 5);
	if (options.stopBits === 2)
		value |= LCR_STOP_BITS_2;
	if (options.parity !== 'none') {
		value |= LCR_ENABLE_PAR;
		if (options.parity === 'even' || options.parity === 'space')
			value |= LCR_PAR_EVEN;
		if (options.parity === 'mark' || options.parity === 'space')
			value |= LCR_MARK_SPACE;
	}
	return value;
}

export class CH341Driver extends BulkSerialDriver {
	static readonly supportedDevices: readonly USBSerialDeviceInfo[] = [
		{ vendorId: 0x1A86, productId: 0x5523, name: 'CH341 Serial' },
		{ vendorId: 0x1A86, productId: 0x7522, name: 'CH340 Serial' },
		{ vendorId: 0x1A86, productId: 0x7523, name: 'CH340' },
		{ vendorId: 0x2184, productId: 0x0057, name: 'CH341 Serial' },
		{ vendorId: 0x4348, productId: 0x5523, name: 'CH341 Serial' },
		{ vendorId: 0x9986, productId: 0x7523, name: 'CH340 Serial' },
	];

	static getInterfaceNumbers(device: USBDevice): readonly number[] {
		const configuration = device.configuration ?? device.configurations[0];
		if (!configuration)
			return [];
		return findBulkInterfaceNumbers(device).filter(interfaceNumber => {
			const deviceInterface = configuration.interfaces.find(item => item.interfaceNumber === interfaceNumber);
			return deviceInterface ? activeAlternate(deviceInterface).endpoints.some(endpoint =>
				endpoint.direction === 'in' && endpoint.type === 'interrupt',
			) : false;
		});
	}

	private version = 0;
	private limitedPrescaler = false;
	private simulatedBreak = false;
	private modemControl = 0;
	private modemStatus = 0;
	private lineControl = LCR_ENABLE_RX | LCR_ENABLE_TX | 3;
	private breakEnd = 0;

	protected selectPort(): BulkSerialPort {
		const port = selectBulkPort(this.device, this.requestedInterfaceNumber);
		if (!port.statusEndpoint)
			throw new WebUSBError('CH341 interface has no interrupt-in status endpoint');
		return port;
	}

	protected async initialize(options: USBSerialOpenOptions): Promise<number> {
		const version = bytes(await this.vendorIn(REQUEST_READ_VERSION, 0, 0, 2), 2, 'CH341 version request');
		this.version = version[0];
		await this.vendorOut(REQUEST_SERIAL_INIT, 0, 0);
		await this.setBaudRateAndLine(9600, LCR_ENABLE_RX | LCR_ENABLE_TX | 3);
		await this.writeModemControl();
		const breakResult = await this.device.controlTransferIn({
			requestType: 'vendor', recipient: 'device', request: REQUEST_READ_REG, value: REG_BREAK, index: 0,
		}, 2);
		if (breakResult.status === 'stall') {
			this.limitedPrescaler = true;
			this.simulatedBreak = true;
		} else {
			bytes(breakResult, 2, 'CH341 break-register request');
		}
		this.modemControl = BIT_DTR | BIT_RTS;
		const baudRate = await this.configure(options);
		const status = bytes(await this.vendorIn(REQUEST_READ_REG, 0x0706, 0, 2), 2, 'CH341 status request');
		this.modemStatus = ~status[0] & 0x0F;
		if (debug.enabled)
			debug('version 0x%s at %d baud', this.version.toString(16), baudRate);
		return baudRate;
	}

	protected async configure(options: USBSerialOpenOptions): Promise<number> {
		const baudRate = Math.min(MAX_BAUD_RATE, Math.max(MIN_BAUD_RATE, options.baudRate));
		this.lineControl = encodeLineControl(options);
		await this.setBaudRateAndLine(baudRate, this.lineControl);
		await this.writeModemControl();
		const flow = options.rtscts ? 1 : 0;
		await this.vendorOut(REQUEST_WRITE_REG, REG_FLOW_CTL << 8 | REG_FLOW_CTL, flow << 8 | flow);
		return baudRate;
	}

	protected async setSignals(options: SetOptions): Promise<void> {
		if (options.dtr !== undefined)
			this.modemControl = options.dtr ? this.modemControl | BIT_DTR : this.modemControl & ~BIT_DTR;
		if (options.rts !== undefined)
			this.modemControl = options.rts ? this.modemControl | BIT_RTS : this.modemControl & ~BIT_RTS;
		if (options.dtr !== undefined || options.rts !== undefined)
			await this.writeModemControl();
		if (options.brk !== undefined)
			await this.setBreak(options.brk);
	}

	protected async readStatus(): Promise<PortStatus> {
		return {
			cts: Boolean(this.modemStatus & BIT_CTS),
			dsr: Boolean(this.modemStatus & BIT_DSR),
			dcd: Boolean(this.modemStatus & BIT_DCD),
		};
	}

	protected processStatus(data: Uint8Array): void {
		if (data.length < 4)
			throw new WebUSBError(`CH341 status response is too short: ${data.length}`, { cause: data });
		this.modemStatus = ~data[2] & 0x0F;
	}

	private async setBaudRateAndLine(baudRate: number, lineControl: number): Promise<void> {
		let divisor = encodeCH341Divisor(baudRate, this.limitedPrescaler);
		if (this.version > 0x27)
			divisor |= 0x80;
		await this.vendorOut(REQUEST_WRITE_REG, REG_DIVISOR << 8 | REG_PRESCALER, divisor);
		if (this.version >= 0x30)
			await this.vendorOut(REQUEST_WRITE_REG, REG_LCR2 << 8 | REG_LCR, lineControl);
	}

	private async writeModemControl(): Promise<void> {
		await this.vendorOut(REQUEST_MODEM_CTRL, ~this.modemControl & 0xFF, 0);
	}

	private async setBreak(enabled: boolean): Promise<void> {
		if (this.simulatedBreak) {
			await this.setSimulatedBreak(enabled);
			return;
		}
		const value = REG_LCR << 8 | REG_BREAK;
		const registers = bytes(await this.vendorIn(REQUEST_READ_REG, value, 0, 2), 2, 'CH341 break-register request');
		if (enabled) {
			registers[0] &= ~1;
			registers[1] &= ~LCR_ENABLE_TX;
		} else {
			registers[0] |= 1;
			registers[1] |= LCR_ENABLE_TX;
		}
		await this.vendorOut(REQUEST_WRITE_REG, value, registers[0] | registers[1] << 8);
	}

	private async setSimulatedBreak(enabled: boolean): Promise<void> {
		if (enabled) {
			await this.setBaudRateAndLine(MIN_BAUD_RATE, LCR_ENABLE_RX | LCR_ENABLE_TX | 3);
			try {
				await this.write(new Uint8Array(1));
			} catch (error) {
				await this.setBaudRateAndLine(this.requireOptions().baudRate, this.lineControl);
				throw error;
			}
			this.breakEnd = performance.now() + 11_000 / MIN_BAUD_RATE;
			return;
		}

		const delay = this.breakEnd - performance.now();
		if (delay > 0)
			await new Promise(resolve => setTimeout(resolve, delay));
		await this.setBaudRateAndLine(this.requireOptions().baudRate, this.lineControl);
	}

	private vendorIn(request: number, value: number, index: number, length: number): Promise<USBInTransferResult> {
		return this.device.controlTransferIn({ requestType: 'vendor', recipient: 'device', request, value, index }, length);
	}

	private async vendorOut(request: number, value: number, index: number): Promise<void> {
		const result = await this.device.controlTransferOut({
			requestType: 'vendor', recipient: 'device', request, value, index,
		});
		if (result.status !== 'ok')
			throw new WebUSBError(`CH341 request 0x${request.toString(16)} failed`, { cause: result });
	}
}
