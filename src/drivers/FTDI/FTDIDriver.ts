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
import {
	FTDI_DEVICES,
	FTDI_DEVICE_RULES,
	type FTDIDeviceRule,
	type FTDIQuirk,
} from './devices.js';
import type { USBSerialDeviceInfo, USBSerialOpenOptions } from '../types.js';

const debug = createDebug('serialport/bindings-webusb/ftdi');

const RESET = 0;
const MODEM_CTRL = 1;
const SET_FLOW_CTRL = 2;
const SET_BAUD_RATE = 3;
const SET_DATA = 4;
const GET_MODEM_STATUS = 5;
const SET_LATENCY_TIMER = 9;
const GET_LATENCY_TIMER = 0x0A;
const SET_DTR_HIGH = 0x0101;
const SET_DTR_LOW = 0x0100;
const SET_RTS_HIGH = 0x0202;
const SET_RTS_LOW = 0x0200;
const BREAK = 1 << 14;
const STATUS_CTS = 0x10;
const STATUS_DSR = 0x20;
const STATUS_DCD = 0x80;

export type FTDIType =
	'SIO' |
	'FT232A' |
	'FT232B' |
	'FT2232C' |
	'FT232R' |
	'FT232H' |
	'FT2232H' |
	'FT4232H' |
	'FT4232HA' |
	'FT232HP' |
	'FT233HP' |
	'FT2232HP' |
	'FT2233HP' |
	'FT4232HP' |
	'FT4233HP' |
	'FTX';

const HIGH_SPEED_TYPES = new Set<FTDIType>([
	'FT232H',
	'FT2232H',
	'FT4232H',
	'FT4232HA',
	'FT232HP',
	'FT233HP',
	'FT2232HP',
	'FT2233HP',
	'FT4232HP',
	'FT4233HP',
]);

function bcdVersion(device: USBDevice): number {
	return device.deviceVersionMajor << 8 | device.deviceVersionMinor << 4 | device.deviceVersionSubminor;
}

function determineType(device: USBDevice): FTDIType {
	const version = bcdVersion(device);
	if (version < 0x200)
		return 'SIO';
	switch (version) {
		case 0x0200: return 'FT232A';
		case 0x0400: return 'FT232B';
		case 0x0500: return 'FT2232C';
		case 0x0600: return 'FT232R';
		case 0x0700: return 'FT2232H';
		case 0x0800: return 'FT4232H';
		case 0x0900: return 'FT232H';
		case 0x1000: return 'FTX';
		case 0x2800: return 'FT2233HP';
		case 0x2900: return 'FT4233HP';
		case 0x3000: return 'FT2232HP';
		case 0x3100: return 'FT4232HP';
		case 0x3200: return 'FT233HP';
		case 0x3300: return 'FT232HP';
		case 0x3600: return 'FT4232HA';
		default: throw new WebUSBError(`Unsupported FTDI revision 0x${version.toString(16)}`);
	}
}

export function encodeFTDIBaudRate(baudRate: number, type: FTDIType = 'FT232R'): number {
	if (type === 'SIO') {
		const rates = [300, 600, 1200, 2400, 4800, 9600, 19200, 38400, 57600, 115200];
		const index = rates.indexOf(baudRate);
		return index === -1 ? 5 : index;
	}
	const highSpeed = HIGH_SPEED_TYPES.has(type) && baudRate >= 1200 && baudRate <= 12_000_000;
	const maximum = HIGH_SPEED_TYPES.has(type) ? 12_000_000 : 3_000_000;
	const requested = baudRate > maximum ? 9600 : baudRate;
	let divisor3 = highSpeed ?
		Math.round(8 * 120_000_000 / (10 * requested)) :
		Math.round(48_000_000 / (2 * requested));
	if (type === 'FT232A') {
		if ((divisor3 & 7) === 7)
			divisor3++;
		let divisor = divisor3 >> 3;
		const fraction = divisor3 & 7;
		if (fraction === 1)
			divisor |= 0xC000;
		else if (fraction >= 4)
			divisor |= 0x4000;
		else if (fraction !== 0)
			divisor |= 0x8000;
		else if (divisor === 1)
			divisor = 0;
		return divisor;
	}
	const fractions = [0, 3, 2, 4, 1, 5, 6, 7];
	let divisor = divisor3 >> 3 | fractions[divisor3 & 7] << 14;
	if (divisor === 1)
		divisor = 0;
	else if (divisor === 0x4001)
		divisor = 1;
	if (highSpeed)
		divisor |= 0x00020000;
	return divisor;
}

function normalizeBaudRate(baudRate: number, type: FTDIType): number {
	if (type === 'SIO')
		return [300, 600, 1200, 2400, 4800, 9600, 19200, 38400, 57600, 115200].includes(baudRate) ? baudRate : 9600;
	const maximum = HIGH_SPEED_TYPES.has(type) ? 12_000_000 : 3_000_000;
	return baudRate <= maximum ? baudRate : 9600;
}

function encodeData(options: USBSerialOpenOptions): number {
	let value = options.dataBits === 7 ? 7 : options.dataBits === 5 ? 0 : 8;
	value |= { none: 0, odd: 1, even: 2, mark: 3, space: 4 }[options.parity] << 8;
	if (options.stopBits === 2)
		value |= 2 << 11;
	return value;
}

function readUSBString(device: USBDevice, property: 'manufacturerName' | 'productName'): string | undefined {
	try {
		return device[property] ?? undefined;
	} catch {
		return undefined;
	}
}

function ruleMatchesInterface(rule: FTDIDeviceRule, deviceInterface: USBInterface): boolean {
	if (rule.interfaceNumber !== undefined && rule.interfaceNumber !== deviceInterface.interfaceNumber)
		return false;
	const alternate = activeAlternate(deviceInterface);
	if (rule.interfaceClass !== undefined && rule.interfaceClass !== alternate.interfaceClass)
		return false;
	if (rule.interfaceSubclass !== undefined && rule.interfaceSubclass !== alternate.interfaceSubclass)
		return false;
	if (rule.interfaceProtocol !== undefined && rule.interfaceProtocol !== alternate.interfaceProtocol)
		return false;
	return true;
}

function quirkAllowsInterface(rule: FTDIDeviceRule, device: USBDevice, interfaceNumber: number): boolean {
	if (rule.quirk === 'jtag')
		return interfaceNumber !== 0;
	if (rule.quirk === 'stmclite')
		return interfaceNumber >= 2;
	if (rule.quirk !== '8u2232c' || interfaceNumber !== 0)
		return true;
	const manufacturer = readUSBString(device, 'manufacturerName');
	if (manufacturer === 'CALAO Systems')
		return false;
	const product = readUSBString(device, 'productName');
	return product !== 'Arrow USB Blaster' && product !== 'BeagleBone/XDS100V2' && product !== 'SNAP Connect E10';
}

function findDeviceRule(device: USBDevice, interfaceNumber: number): FTDIDeviceRule | undefined {
	const configuration = device.configuration ?? device.configurations[0];
	const deviceInterface = configuration?.interfaces.find(item => item.interfaceNumber === interfaceNumber);
	if (!deviceInterface)
		return undefined;
	return FTDI_DEVICE_RULES.find(rule =>
		rule.vendorId === device.vendorId &&
		rule.productId === device.productId &&
		ruleMatchesInterface(rule, deviceInterface) &&
		quirkAllowsInterface(rule, device, interfaceNumber),
	);
}

export class FTDIDriver extends BulkSerialDriver {
	static readonly supportedDevices: readonly USBSerialDeviceInfo[] = FTDI_DEVICES;

	static getInterfaceNumbers(device: USBDevice): readonly number[] {
		return findBulkInterfaceNumbers(device).filter(interfaceNumber =>
			findDeviceRule(device, interfaceNumber) !== undefined,
		);
	}

	private type: FTDIType = 'FT232R';
	private quirk?: FTDIQuirk;
	private channel = 0;
	private dataValue = 8;
	private modemStatus = 0;

	protected get bulkReadLength(): number {
		return 512;
	}

	protected get bulkWriteLength(): number {
		if (this.type !== 'SIO')
			return 256;
		const packetSize = this.port?.outEndpoint.packetSize ?? 64;
		return (packetSize - 1) * Math.floor(256 / packetSize);
	}

	protected selectPort(): BulkSerialPort {
		const port = selectBulkPort(this.device, this.requestedInterfaceNumber);
		if (!findDeviceRule(this.device, port.controlInterfaceNumber))
			throw new WebUSBError(`FTDI interface ${port.controlInterfaceNumber} is not supported by the Linux device rule`);
		return port;
	}

	protected async initialize(options: USBSerialOpenOptions): Promise<number> {
		this.type = determineType(this.device);
		this.quirk = findDeviceRule(this.device, this.requirePort().controlInterfaceNumber)?.quirk;
		this.channel = ['SIO', 'FT232A', 'FT232B', 'FT232R'].includes(this.type) ?
			0 : this.requirePort().controlInterfaceNumber + 1;
		if (this.type === 'FT232A' && this.device.serialNumber === null) {
			const latency = await this.vendorIn(GET_LATENCY_TIMER, 1);
			if (latency.status === 'ok' && latency.data?.byteLength === 1)
				this.type = 'FT232B';
		}
		if (this.type !== 'SIO' && this.type !== 'FT232A') {
			const latency = await this.vendorIn(GET_LATENCY_TIMER, 1);
			let value = 16;
			if (this.quirk === 'ndi')
				value = 1;
			else if (latency.status === 'ok' && latency.data?.byteLength === 1)
				value = latency.data.getUint8(0);
			await this.vendorOut(SET_LATENCY_TIMER, value, this.channel);
		}
		await this.vendorOut(RESET, 0, this.channel);
		const baudRate = await this.configure(options);
		await this.writeSignals(true, true);
		if (debug.enabled)
			debug('detected %s at %d baud', this.type, baudRate);
		return baudRate;
	}

	protected async configure(options: USBSerialOpenOptions): Promise<number> {
		this.dataValue = encodeData(options);
		await this.vendorOut(SET_DATA, this.dataValue, this.channel);
		let baudRate = normalizeBaudRate(options.baudRate, this.type);
		let encodedBaudRate = baudRate;
		if (this.quirk === 'usb-uirt') {
			baudRate = 38400;
			encodedBaudRate = Math.floor(24_000_000 / 77);
		} else if (this.quirk === 'he-tira1') {
			baudRate = 38400;
			encodedBaudRate = 100_000;
		} else if (this.quirk === 'ndi' && baudRate === 19200) {
			baudRate = 1_200_000;
			encodedBaudRate = baudRate;
		}
		const divisor = encodeFTDIBaudRate(encodedBaudRate, this.type);
		let baudIndex = divisor >>> 16;
		if (this.channel)
			baudIndex = baudIndex << 8 | this.channel;
		await this.vendorOut(SET_BAUD_RATE, divisor & 0xFFFF, baudIndex);
		let flowIndex = this.channel;
		let flowValue = 0;
		if (options.rtscts || this.quirk === 'he-tira1') {
			flowIndex |= 1 << 8;
		} else if (options.xon) {
			flowIndex |= 4 << 8;
			flowValue = 0x1311;
		}
		await this.vendorOut(SET_FLOW_CTRL, flowValue, flowIndex);
		return baudRate;
	}

	protected async setSignals(options: SetOptions): Promise<void> {
		if (options.dtr !== undefined || options.rts !== undefined)
			await this.writeSignals(options.dtr, options.rts);
		if (options.brk !== undefined)
			await this.vendorOut(SET_DATA, this.dataValue | (options.brk ? BREAK : 0), this.channel);
	}

	protected async readStatus(): Promise<PortStatus> {
		const result = await this.vendorIn(GET_MODEM_STATUS, this.type === 'SIO' ? 1 : 2);
		if (result.status !== 'ok' || !result.data || result.data.byteLength < 1)
			throw new WebUSBError('FTDI modem-status request failed', { cause: result });
		this.modemStatus = result.data.getUint8(0);
		return this.currentStatus();
	}

	protected processInput(data: Uint8Array): readonly Uint8Array[] {
		const packetSize = this.requirePort().inEndpoint.packetSize || 64;
		const results: Uint8Array[] = [];
		for (let offset = 0; offset < data.length; offset += packetSize) {
			const packet = data.subarray(offset, Math.min(offset + packetSize, data.length));
			if (packet.length < 2)
				throw new WebUSBError(`FTDI input packet is too short: ${packet.length}`, { cause: packet });
			this.modemStatus = packet[0];
			if (packet.length > 2)
				results.push(packet.subarray(2));
		}
		return results;
	}

	protected encodeOutput(data: Uint8Array): readonly Uint8Array[] {
		if (this.type !== 'SIO')
			return [data];
		const packetSize = this.requirePort().outEndpoint.packetSize;
		const payloadSize = packetSize - 1;
		const packets = Math.ceil(data.length / payloadSize);
		const output = new Uint8Array(data.length + packets);
		let sourceOffset = 0;
		let outputOffset = 0;
		while (sourceOffset < data.length) {
			const count = Math.min(payloadSize, data.length - sourceOffset);
			output[outputOffset] = count << 2 | 1;
			output.set(data.subarray(sourceOffset, sourceOffset + count), outputOffset + 1);
			sourceOffset += count;
			outputOffset += count + 1;
		}
		return [output];
	}

	private currentStatus(): PortStatus {
		return {
			cts: Boolean(this.modemStatus & STATUS_CTS),
			dsr: Boolean(this.modemStatus & STATUS_DSR),
			dcd: Boolean(this.modemStatus & STATUS_DCD),
		};
	}

	private async writeSignals(dtr?: boolean, rts?: boolean): Promise<void> {
		let value = 0;
		if (dtr !== undefined) {
			value |= dtr ? SET_DTR_HIGH : SET_DTR_LOW;
		}
		if (rts !== undefined) {
			value |= rts ? SET_RTS_HIGH : SET_RTS_LOW;
		}
		if (value)
			await this.vendorOut(MODEM_CTRL, value, this.channel);
	}

	private vendorIn(request: number, length: number): Promise<USBInTransferResult> {
		return this.device.controlTransferIn({
			requestType: 'vendor', recipient: 'device', request, value: 0, index: this.channel,
		}, length);
	}

	private async vendorOut(request: number, value: number, index: number): Promise<void> {
		const result = await this.device.controlTransferOut({
			requestType: 'vendor', recipient: 'device', request, value, index,
		});
		if (result.status !== 'ok')
			throw new WebUSBError(`FTDI request 0x${request.toString(16)} failed`, { cause: result });
	}
}
