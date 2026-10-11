import type { PortStatus, SetOptions, UpdateOptions } from '@serialport/bindings-interface' with { 'resolution-mode': 'require' };
import createDebug from 'debug';
import { ByteRingBuffer } from '../../ByteRingBuffer.js';
import { dataViewBytes, formatUSBId } from '../../utils.js';
import { WebUSBError } from '../../WebUSBError.js';
import { transferOutChunks } from '../transferOut.js';
import type { USBSerialDeviceInfo, USBSerialDriver, USBSerialOpenOptions } from '../types.js';

const debug = createDebug('serialport/bindings-webusb/pl2303');

const REQUEST_SET_LINE = 0x20;
const REQUEST_GET_LINE = 0x21;
const REQUEST_SET_CONTROL = 0x22;
const REQUEST_BREAK = 0x23;
const REQUEST_VENDOR = 0x01;
const REQUEST_VENDOR_N = 0x80;
const REQUEST_VENDOR_READ_N = 0x81;
const REQUEST_VENDOR_READ_MP = 0x80;
const REQUEST_RESET_MP = 0x96;
const REQUEST_GET_DESCRIPTOR = 0x06;

const DEVICE_DESCRIPTOR = 0x01;
const DEVICE_DESCRIPTOR_HEADER_SIZE = 8;
const MAX_PACKET_SIZE_0_INDEX = 7;

const CONTROL_DTR = 0x01;
const CONTROL_RTS = 0x02;
const BREAK_ON = 0xFFFF;
const BREAK_OFF = 0x0000;

const UART_STATE_INDEX = 8;
const UART_DCD = 0x01;
const UART_DSR = 0x02;
const UART_BREAK_ERROR = 0x04;
const UART_FRAME_ERROR = 0x10;
const UART_PARITY_ERROR = 0x20;
const UART_OVERRUN_ERROR = 0x40;
const UART_CTS = 0x80;
const UART_ERROR_MASK = UART_BREAK_ERROR | UART_FRAME_ERROR | UART_PARITY_ERROR | UART_OVERRUN_ERROR;

const BULK_READ_COUNT = 2;
const BROWSER_BULK_READ_BUDGET_MS = 200;
const BROWSER_BULK_READ_MAX_COUNT = 32 * 1024;
const BULK_READ_SIZE = 256;
const BULK_READ_BUFFER_SIZE = 64 * 1024;
const BULK_WRITE_SIZE = 256;

const FLOW_CONTROL_MASK = 0xF0;
const HXN_RESET_REG = 0x07;
const HXN_RESET_BOTH_PIPES = 0x03;
const HXN_FLOW_CONTROL_REG = 0x0A;
const HXN_FLOW_CONTROL_MASK = 0x1C;
const HXN_FLOW_CONTROL_NONE = 0x1C;
const HXN_FLOW_CONTROL_RTS_CTS = 0x18;
const HXN_FLOW_CONTROL_XON_XOFF = 0x0C;

const MP_FLOW_CONTROL_REGISTERS = [0xC005, 0xD005, 0xE005, 0xF005] as const;
const MP_FLOW_CONTROL_NONE = 0x00;
const MP_FLOW_CONTROL_RTS_CTS = 0x03;
const MP_FLOW_CONTROL_XON_XOFF = 0x40;

const SUPPORTED_BAUD_RATES = [
	75, 150, 300, 600, 1200, 1800, 2400, 3600, 4800, 7200, 9600,
	14400, 19200, 28800, 38400, 57600, 115200, 230400, 460800,
	614400, 921600, 1228800, 2457600, 3000000, 6000000,
];

const MP_DEVICE_VERSIONS = [
	0x3302, 0x3304, 0x4302, 0x4304, 0x6502, 0x6504, 0x6506,
];

export type PL2303Type = 'H' | 'HX' | 'TA' | 'TB' | 'HXD' | 'HXN' | 'MP';

interface PL2303TypeData {
	maxBaudRate: number;
	legacy?: boolean;
	noAutoXonXoff?: boolean;
	noDivisors?: boolean;
	altDivisors?: boolean;
}

interface PL2303DeviceInfo extends USBSerialDeviceInfo {
	uartStateIndex?: number;
	interruptFromFirstInterface?: boolean;
	bulkReadCount?: number;
}

const TYPE_DATA: Readonly<Record<PL2303Type, PL2303TypeData>> = {
	H: { maxBaudRate: 1228800, legacy: true, noAutoXonXoff: true },
	HX: { maxBaudRate: 6000000 },
	TA: { maxBaudRate: 6000000, altDivisors: true },
	TB: { maxBaudRate: 12000000, altDivisors: true },
	HXD: { maxBaudRate: 12000000 },
	HXN: { maxBaudRate: 12000000, noDivisors: true },
	MP: { maxBaudRate: 24000000, noDivisors: true },
};

const PL2303_DEVICES: readonly PL2303DeviceInfo[] = [
	{ vendorId: 0x067B, productId: 0x2303, name: 'PL2303 Serial Port / Mobile Phone Data Cable', interruptFromFirstInterface: true },
	{ vendorId: 0x067B, productId: 0x04BB, name: 'PL2303 Serial (IODATA USB-RSAQ2)' },
	{ vendorId: 0x067B, productId: 0x1234, name: 'Prolific Technology, Inc.' },
	{ vendorId: 0x067B, productId: 0xAAA2, name: 'PL2303 Serial Adapter (IODATA USB-RSAQ3)' },
	{ vendorId: 0x067B, productId: 0xAAA8, name: 'Prolific Technology, Inc.' },
	{ vendorId: 0x067B, productId: 0xAAA0, name: 'Prolific Pharos' },
	{ vendorId: 0x067B, productId: 0x0611, name: 'AlDiga AL-11U Quad-band GSM/GPRS/EDGE modem' },
	{ vendorId: 0x067B, productId: 0x0612, name: 'Prolific Technology, Inc.' },
	{ vendorId: 0x067B, productId: 0x0609, name: 'Prolific Technology, Inc.' },
	{ vendorId: 0x067B, productId: 0x331A, name: 'Prolific Technology, Inc.' },
	{ vendorId: 0x067B, productId: 0x0307, name: 'Motorola Serial Adapter' },
	{ vendorId: 0x067B, productId: 0xE1F1, name: 'Prolific Technology, Inc.' },
	{ vendorId: 0x067B, productId: 0x2304, name: 'Prolific Technology, Inc.' },
	{ vendorId: 0x067B, productId: 0x23A3, name: 'ATEN Serial Bridge' },
	{ vendorId: 0x067B, productId: 0x23B3, name: 'Prolific Technology, Inc.' },
	{ vendorId: 0x067B, productId: 0x23C3, name: 'Prolific Technology, Inc.' },
	{ vendorId: 0x067B, productId: 0x23D3, name: 'Prolific Technology, Inc.' },
	{ vendorId: 0x067B, productId: 0x23E3, name: 'Prolific Technology, Inc.' },
	{ vendorId: 0x067B, productId: 0x23F3, name: 'Prolific Technology, Inc.' },
	{ vendorId: 0x067B, productId: 0x2533, name: 'PL256X Multi-Port Serial Adapter' },
	{ vendorId: 0x04BB, productId: 0x0A03, name: 'Serial USB-RSAQ1' },
	{ vendorId: 0x04BB, productId: 0x0A0E, name: 'I-O Data Device, Inc.' },
	{ vendorId: 0x0557, productId: 0x2008, name: 'UC-232A Serial Port [pl2303]', interruptFromFirstInterface: true },
	{ vendorId: 0x0557, productId: 0x2021, name: 'ATEN International Co., Ltd', interruptFromFirstInterface: true },
	{ vendorId: 0x0557, productId: 0x2022, name: 'ATEN International Co., Ltd', interruptFromFirstInterface: true },
	{ vendorId: 0x0557, productId: 0x2118, name: 'ATEN International Co., Ltd' },
	{ vendorId: 0x0547, productId: 0x2008, name: 'Anchor Chips, Inc.' },
	{ vendorId: 0x056E, productId: 0x5003, name: 'UC-SGT' },
	{ vendorId: 0x056E, productId: 0x5004, name: 'UC-SGT' },
	{ vendorId: 0x0EBA, productId: 0x1080, name: 'Itegno' },
	{ vendorId: 0x0EBA, productId: 0x2080, name: 'Itegno' },
	{ vendorId: 0x0DF7, productId: 0x0620, name: 'MA-620 Infrared Adapter' },
	{ vendorId: 0x0584, productId: 0xB000, name: 'REX-USB60' },
	{ vendorId: 0x2478, productId: 0x2008, name: 'U209-000-R Serial Port' },
	{ vendorId: 0x1453, productId: 0x4026, name: '26-183 Serial Cable' },
	{ vendorId: 0x0731, productId: 0x0528, name: 'SonyEricsson DCU-11 Cable' },
	{ vendorId: 0x6189, productId: 0x2068, name: 'USB to serial cable (v2)' },
	{ vendorId: 0x11F7, productId: 0x02DF, name: 'Serial cable (v2) for TD-10 Mobile Phone' },
	{ vendorId: 0x11F5, productId: 0x0001, name: 'SX1', uartStateIndex: 0 },
	{ vendorId: 0x11F5, productId: 0x0002, name: 'DCA-540' },
	{ vendorId: 0x11F5, productId: 0x0003, name: 'Mobile phone USB cable', uartStateIndex: 0 },
	{
		vendorId: 0x11F5,
		productId: 0x0004,
		name: 'X75',
		uartStateIndex: 0,
		bulkReadCount: 2,
	},
	{ vendorId: 0x11F5, productId: 0x0005, name: 'SXG75/EF81', interruptFromFirstInterface: true },
	{ vendorId: 0x11F5, productId: 0x0006, name: 'DCA-540' },
	{ vendorId: 0x11F5, productId: 0x0007, name: 'DCA-540' },
	{
		vendorId: 0x11F5,
		productId: 0x1004,
		name: 'DCA-140',
		uartStateIndex: 0,
		bulkReadCount: 2,
	},
	{ vendorId: 0x04A5, productId: 0x4027, name: 'Acer Peripherals Inc. (now BenQ Corp.)' },
	{ vendorId: 0x0745, productId: 0x0001, name: 'Syntech Information Co., Ltd' },
	{ vendorId: 0x078B, productId: 0x1234, name: 'Happ Controls, Inc.' },
	{ vendorId: 0x10B5, productId: 0xAC70, name: 'Comodo (PLX?)' },
	{ vendorId: 0x079B, productId: 0x0027, name: 'USB-Serial Controller' },
	{ vendorId: 0x0413, productId: 0x2101, name: 'Leadtek Research, Inc.' },
	{ vendorId: 0x0E55, productId: 0x110B, name: 'MS3303H USB-to-Serial Bridge' },
	{ vendorId: 0x0731, productId: 0x2003, name: 'Susteen, Inc.' },
	{ vendorId: 0x050D, productId: 0x0257, name: 'F5U257 Serial' },
	{ vendorId: 0x058F, productId: 0x9720, name: 'USB-Serial Adapter', interruptFromFirstInterface: true },
	{ vendorId: 0x11F6, productId: 0x2001, name: 'Willcom WSIM' },
	{ vendorId: 0x07AA, productId: 0x002A, name: 'Corega K.K.' },
	{ vendorId: 0x05AD, productId: 0x0FBA, name: 'Y.C. Cable U.S.A., Inc.' },
	{ vendorId: 0x5372, productId: 0x2303, name: 'Superial USB-Serial' },
	{ vendorId: 0x03F0, productId: 0x3524, name: 'HP, Inc' },
	{ vendorId: 0x03F0, productId: 0x4349, name: 'HP, Inc' },
	{ vendorId: 0x03F0, productId: 0x0F7F, name: 'HP, Inc' },
	{ vendorId: 0x03F0, productId: 0x0183, name: 'HP, Inc' },
	{ vendorId: 0x03F0, productId: 0x0B39, name: 'HP, Inc' },
	{ vendorId: 0x03F0, productId: 0x4439, name: 'HP, Inc' },
	{ vendorId: 0x03F0, productId: 0x3139, name: 'HP, Inc' },
	{ vendorId: 0x03F0, productId: 0x3239, name: 'HP, Inc' },
	{ vendorId: 0x03F0, productId: 0x026B, name: 'HP, Inc' },
	{ vendorId: 0x03F0, productId: 0x0F9B, name: 'HP, Inc' },
	{ vendorId: 0x03F0, productId: 0x5039, name: 'HP, Inc' },
	{ vendorId: 0x03F0, productId: 0x0956, name: 'HP, Inc' },
	{ vendorId: 0x04B8, productId: 0x0521, name: 'Seiko Epson Corp.' },
	{ vendorId: 0x04B8, productId: 0x0522, name: 'Seiko Epson Corp.' },
	{ vendorId: 0x054C, productId: 0x0437, name: 'Sony Corp.' },
	{ vendorId: 0x11AD, productId: 0x0001, name: 'Sanwa KB-USB2 multimeter cable' },
	{ vendorId: 0x0B63, productId: 0x6530, name: 'ADLink Technology, Inc.' },
	{ vendorId: 0x0B63, productId: 0x653A, name: 'ADLink Technology, Inc.' },
	{ vendorId: 0x0B8C, productId: 0x2303, name: 'SMART Technologies Inc.' },
	{ vendorId: 0x0CAA, productId: 0x3001, name: 'AT-VT-Kit3 Serial Adapter' },
	{ vendorId: 0x04B3, productId: 0x4016, name: 'IBM Corp.' },
	{ vendorId: 0x345F, productId: 0x3020, name: 'Macrosilicon MS3020' },
];

interface PL2303Endpoints {
	dataInterface: number;
	inEndpoint: USBEndpoint;
	outEndpoint: USBEndpoint;
	statusInterface: number;
	statusEndpoint: USBEndpoint;
}

interface BulkReadFailure {
	error: unknown;
}

interface BulkReadReceiver {
	buffer: Uint8Array;
	offset: number;
	length: number;
	resolve(bytesRead: number): void;
	reject(error: unknown): void;
}

export interface EncodedBaudRate {
	baudRate: number;
	data: Uint8Array<ArrayBuffer>;
}

function writeBaudRate(baudRate: number): Uint8Array<ArrayBuffer> {
	const data = new Uint8Array(4);
	new DataView(data.buffer).setUint32(0, baudRate, true);
	return data;
}

function nearestSupportedBaudRate(baudRate: number): number {
	let nearest: number = SUPPORTED_BAUD_RATES[0];
	for (const supported of SUPPORTED_BAUD_RATES) {
		if (Math.abs(supported - baudRate) <= Math.abs(nearest - baudRate))
			nearest = supported;
	}
	return nearest;
}

function encodeDivisorBaudRate(baudRate: number): EncodedBaudRate {
	const baseline = 12000000 * 32;
	let mantissa = Math.floor(baseline / baudRate);
	let exponent = 0;

	while (mantissa >= 512) {
		if (exponent < 7) {
			mantissa >>= 2;
			exponent++;
		} else {
			mantissa = 511;
			break;
		}
	}

	return {
		baudRate: Math.floor(baseline / mantissa) >> (exponent << 1),
		data: new Uint8Array([
			mantissa & 0xFF,
			(exponent << 1) | (mantissa >> 8),
			0,
			0x80,
		]),
	};
}

function encodeAltDivisorBaudRate(baudRate: number): EncodedBaudRate {
	const baseline = 12000000 * 32;
	let mantissa = Math.floor(baseline / baudRate);
	let exponent = 0;

	while (mantissa >= 2048) {
		if (exponent < 15) {
			mantissa >>= 1;
			exponent++;
		} else {
			mantissa = 2047;
			break;
		}
	}

	return {
		baudRate: Math.floor(baseline / mantissa) >> exponent,
		data: new Uint8Array([
			mantissa & 0xFF,
			((exponent & ~1) << 4) | (mantissa >> 8),
			exponent & 1,
			0x80,
		]),
	};
}

export function encodePL2303BaudRate(requestedBaudRate: number, type: PL2303Type): EncodedBaudRate {
	if (!Number.isSafeInteger(requestedBaudRate) || requestedBaudRate <= 0)
		throw new RangeError(`Invalid baud rate: ${requestedBaudRate}`);

	const typeData = TYPE_DATA[type];
	const baudRate = Math.min(requestedBaudRate, typeData.maxBaudRate);
	const directBaudRate = typeData.noDivisors ? baudRate : nearestSupportedBaudRate(baudRate);

	if (baudRate === directBaudRate)
		return { baudRate, data: writeBaudRate(baudRate) };
	return typeData.altDivisors ? encodeAltDivisorBaudRate(baudRate) : encodeDivisorBaudRate(baudRate);
}

export function createPL2303LineCoding(options: USBSerialOpenOptions, type: PL2303Type): EncodedBaudRate {
	const encoded = encodePL2303BaudRate(options.baudRate, type);
	const data = new Uint8Array(7);
	data.set(encoded.data);
	if (options.stopBits === 1)
		data[4] = 0;
	else if (options.dataBits === 5)
		data[4] = 1;
	else
		data[4] = 2;
	data[5] = { none: 0, odd: 1, even: 2, mark: 3, space: 4 }[options.parity];
	data[6] = options.dataBits;
	return { baudRate: encoded.baudRate, data };
}

function findPortEndpoints(
	configuration: USBConfiguration,
	deviceInfo: PL2303DeviceInfo,
): PL2303Endpoints[] {
	const firstInterface = configuration.interfaces[0];
	const ports: PL2303Endpoints[] = [];
	for (const iface of configuration.interfaces) {
		const endpoints = iface.alternate.endpoints;
		const inEndpoint = endpoints.find(endpoint => endpoint.direction === 'in' && endpoint.type === 'bulk');
		const outEndpoint = endpoints.find(endpoint => endpoint.direction === 'out' && endpoint.type === 'bulk');
		if (!inEndpoint || !outEndpoint)
			continue;

		let statusInterface = iface;
		let statusEndpoint = endpoints.find(endpoint => endpoint.direction === 'in' && endpoint.type === 'interrupt');
		// Linux PL2303_QUIRK_ENDPOINT_HACK adds the first interface's interrupt endpoint.
		if (!statusEndpoint && deviceInfo.interruptFromFirstInterface && firstInterface !== iface) {
			statusInterface = firstInterface;
			statusEndpoint = firstInterface.alternate.endpoints.find(
				endpoint => endpoint.direction === 'in' && endpoint.type === 'interrupt',
			);
		}
		if (!statusEndpoint)
			continue;
		ports.push({
			dataInterface: iface.interfaceNumber,
			inEndpoint,
			outEndpoint,
			statusInterface: statusInterface.interfaceNumber,
			statusEndpoint,
		});
	}
	return ports;
}

function findEndpoints(
	device: USBDevice,
	deviceInfo: PL2303DeviceInfo,
	interfaceNumber?: number,
): PL2303Endpoints {
	const configuration = device.configuration;
	if (!configuration)
		throw new WebUSBError('USB device has no active configuration');

	const ports = findPortEndpoints(configuration, deviceInfo);
	const endpoints = interfaceNumber === undefined ?
		ports[0] :
		ports.find(port => port.dataInterface === interfaceNumber);
	if (endpoints)
		return endpoints;

	const interfaceDescription = interfaceNumber === undefined ? '' : ` on interface ${interfaceNumber}`;
	throw new WebUSBError(
		`PL2303 requires bulk-in, bulk-out and interrupt-in endpoints on a usable interface${interfaceDescription}`,
	);
}

function bcdVersion(major: number, minor: number, subminor: number): number {
	return (major << 8) | (minor << 4) | subminor;
}

function isStalledTransfer(error: unknown): boolean {
	if (!(error instanceof Error))
		return false;
	const cause = error.cause;
	return typeof cause === 'object' && cause !== null && 'status' in cause && cause.status === 'stall';
}

function* chunkBytes(data: Uint8Array<ArrayBuffer>, size: number): Generator<Uint8Array<ArrayBuffer>> {
	for (let offset = 0; offset < data.byteLength; offset += size)
		yield data.subarray(offset, offset + size);
}

function isBrowserUSBDevice(device: USBDevice): boolean {
	return typeof USBDevice !== 'undefined' && device instanceof USBDevice;
}

function browserBulkReadCount(baudRate: number): number {
	return Math.min(Math.ceil(baudRate / 10 * BROWSER_BULK_READ_BUDGET_MS / 1000), BROWSER_BULK_READ_MAX_COUNT);
}

export class PL2303Driver implements USBSerialDriver {
	static readonly supportedDevices = PL2303_DEVICES;
	static getInterfaceNumbers(device: USBDevice): number[] {
		const deviceInfo = PL2303_DEVICES.find(
			item => item.vendorId === device.vendorId && item.productId === device.productId,
		);
		const configuration = device.configuration ?? device.configurations[0];
		if (!deviceInfo || !configuration)
			return [];
		const interfaceNumbers = findPortEndpoints(configuration, deviceInfo).map(port => port.dataInterface);
		const deviceVersion = bcdVersion(
			device.deviceVersionMajor,
			device.deviceVersionMinor,
			device.deviceVersionSubminor,
		);
		return MP_DEVICE_VERSIONS.includes(deviceVersion) ?
			interfaceNumbers.filter(interfaceNumber => interfaceNumber < MP_FLOW_CONTROL_REGISTERS.length) :
			interfaceNumbers;
	}

	readonly device: USBDevice;
	private readonly deviceInfo: PL2303DeviceInfo;
	private readonly interfaceNumber?: number;
	private endpoints?: PL2303Endpoints;
	private type?: PL2303Type;
	private options?: USBSerialOpenOptions;
	private claimedInterfaces: number[] = [];
	private lineControl = 0;
	private lineSettings?: Uint8Array;
	private lineStatus = 0;
	private statusError?: unknown;
	private noBreakGetLine = false;
	private opened = false;
	private closing?: Promise<void>;
	private readonly bulkReadBuffer = new ByteRingBuffer(BULK_READ_BUFFER_SIZE);
	private bulkReadTarget = 0;
	private bulkReadActive = 0;
	private bulkReadReceiver?: BulkReadReceiver;
	private bulkReadFailure?: BulkReadFailure;

	constructor(device: USBDevice, interfaceNumber?: number) {
		this.device = device;
		this.interfaceNumber = interfaceNumber;
		const deviceInfo = PL2303_DEVICES.find(
			item => item.vendorId === device.vendorId && item.productId === device.productId,
		);
		if (!deviceInfo)
			throw new WebUSBError('Unsupported PL2303 device');
		this.deviceInfo = deviceInfo;
	}

	async open(options: USBSerialOpenOptions): Promise<void> {
		if (this.closing)
			await this.closing;
		if (this.opened)
			return;

		this.options = options;
		this.lineSettings = undefined;
		this.bulkReadFailure = undefined;
		try {
			await this.device.open();
			if (!this.device.configuration) {
				const configuration = this.device.configurations[0];
				if (!configuration)
					throw new WebUSBError('PL2303 has no USB configuration');
				await this.device.selectConfiguration(configuration.configurationValue);
			}

			this.endpoints = findEndpoints(this.device, this.deviceInfo, this.interfaceNumber);
			await this.claimInterface(this.endpoints.dataInterface);
			if (this.endpoints.statusInterface !== this.endpoints.dataInterface) {
				await this.claimInterface(this.endpoints.statusInterface);
			}
			if (this.endpoints.dataInterface !== 0 && this.endpoints.statusInterface !== 0)
				await this.claimInterface(0);

			this.type = await this.detectType();
			if (this.type === 'MP')
				this.getMPFlowControlRegister();
			if (debug.enabled) {
				debug(
					'detected %s:%s type %s',
					formatUSBId(this.device.vendorId),
					formatUSBId(this.device.productId),
					this.type,
				);
			}
			if (this.type === 'HXD')
				this.noBreakGetLine = await this.isHXDClone();
			await this.initializeChip();
			await this.resetPipes();
			options.baudRate = await this.configure(options);
			this.statusError = undefined;
			this.opened = true;
			this.startStatusRead();
			this.resizeBulkReads(options.baudRate);
			this.lineControl = CONTROL_DTR | CONTROL_RTS;
			await this.ignoreStalledRequest(this.setControlLines(), 'set control lines');
		} catch (error) {
			this.opened = false;
			this.bulkReadBuffer.clear();
			await this.cleanupAfterFailedOpen();
			throw error;
		}
	}

	async close(): Promise<void> {
		if (this.closing)
			return this.closing;
		if (!this.opened)
			return;
		this.closing = this.closeTransfer().finally(() => {
			this.closing = undefined;
		});
		return this.closing;
	}

	private async closeTransfer(): Promise<void> {
		this.opened = false;
		const receiver = this.bulkReadReceiver;
		this.bulkReadReceiver = undefined;
		receiver?.reject(new DOMException('The PL2303 device was closed', 'AbortError'));
		if (!this.device.opened) {
			this.claimedInterfaces = [];
			this.bulkReadBuffer.clear();
			this.bulkReadReceiver = undefined;
			return;
		}
		let firstError: unknown;
		const rememberError = (error: unknown) => {
			firstError ??= error;
		};

		if (!this.noBreakGetLine) {
			try {
				await this.setBreak(false);
			} catch (error) {
				if (isStalledTransfer(error)) {
					if (debug.enabled)
						debug('break request is not supported');
				} else {
					rememberError(error);
				}
			}
		}
		if (this.options?.hupcl) {
			try {
				this.lineControl = 0;
				await this.setControlLines();
			} catch (error) {
				if (isStalledTransfer(error)) {
					if (debug.enabled)
						debug('control-line request is not supported');
				} else {
					rememberError(error);
				}
			}
		}

		for (const interfaceNumber of [...this.claimedInterfaces].reverse()) {
			try {
				await this.device.releaseInterface(interfaceNumber);
			} catch (error) {
				rememberError(error);
			}
		}
		try {
			await this.device.close();
		} catch (error) {
			rememberError(error);
		}
		this.claimedInterfaces = [];
		this.bulkReadBuffer.clear();
		this.bulkReadReceiver = undefined;
		if (firstError)
			throw firstError;
	}

	read(buffer: Uint8Array, offset: number, length: number): number | Promise<number> {
		const bytesRead = this.bulkReadBuffer.read(buffer, offset, length);
		if (bytesRead > 0)
			return bytesRead;
		if (this.bulkReadFailure)
			return Promise.reject(this.bulkReadFailure.error);

		return new Promise((resolve, reject) => {
			this.bulkReadReceiver = { buffer, offset, length, resolve, reject };
		});
	}

	async write(data: Uint8Array): Promise<void> {
		const endpoint = this.requireEndpoints().outEndpoint.endpointNumber;
		if (debug.enabled)
			debug('write %d bytes to endpoint %d', data.byteLength, endpoint);
		const transferData = data.buffer instanceof ArrayBuffer ?
			new Uint8Array(data.buffer, data.byteOffset, data.byteLength) :
			Uint8Array.from(data);
		await transferOutChunks(this.device, endpoint, chunkBytes(transferData, BULK_WRITE_SIZE), 'PL2303');
	}

	async flush(): Promise<void> {
		this.bulkReadBuffer.clear();
	}

	async update(options: UpdateOptions): Promise<number> {
		const currentOptions = this.requireOptions();
		if (options.baudRate === currentOptions.baudRate)
			return currentOptions.baudRate;
		const nextOptions = { ...currentOptions, baudRate: options.baudRate };
		if (options.baudRate > currentOptions.baudRate)
			this.resizeBulkReads(options.baudRate);
		const baudRate = await this.configure(nextOptions);
		this.options = { ...nextOptions, baudRate };
		if (this.opened)
			this.resizeBulkReads(baudRate);
		return baudRate;
	}

	async set(options: SetOptions): Promise<void> {
		if (options.dtr !== undefined) {
			this.lineControl = options.dtr ? this.lineControl | CONTROL_DTR : this.lineControl & ~CONTROL_DTR;
		}
		if (options.rts !== undefined) {
			this.lineControl = options.rts ? this.lineControl | CONTROL_RTS : this.lineControl & ~CONTROL_RTS;
		}
		if (options.dtr !== undefined || options.rts !== undefined)
			await this.setControlLines();
		if (options.brk !== undefined)
			await this.setBreak(options.brk);
	}

	async get(): Promise<PortStatus> {
		if (this.statusError)
			throw this.statusError;
		return this.getPortStatus();
	}

	private resizeBulkReads(baudRate: number): void {
		const endpoint = this.requireEndpoints().inEndpoint;
		const deepQueue = this.deviceInfo.bulkReadCount === undefined && isBrowserUSBDevice(this.device);
		this.bulkReadTarget = deepQueue ?
			browserBulkReadCount(baudRate) :
			this.deviceInfo.bulkReadCount ?? BULK_READ_COUNT;
		const transferLength = deepQueue ? endpoint.packetSize : Math.max(BULK_READ_SIZE, endpoint.packetSize);
		if (debug.enabled)
			debug('%d bulk-in transfers of %d bytes at %d baud', this.bulkReadTarget, transferLength, baudRate);
		while (this.bulkReadActive < this.bulkReadTarget) {
			this.bulkReadActive++;
			void this.runBulkRead(endpoint.endpointNumber, transferLength);
		}
	}

	private async runBulkRead(endpoint: number, transferLength: number): Promise<void> {
		try {
			let transfer = this.device.transferIn(endpoint, transferLength);
			while (this.opened) {
				const result = await transfer;
				if (!this.opened)
					return;
				if (result.status === 'stall') {
					this.failBulkRead(new WebUSBError('PL2303 bulk-in endpoint stalled', { cause: result }));
					return;
				}
				if (result.status !== 'ok') {
					this.failBulkRead(
						new WebUSBError(`PL2303 bulk-in transfer failed with status ${result.status}`, { cause: result }),
					);
					return;
				}

				const retire = this.bulkReadActive > this.bulkReadTarget;
				if (!retire)
					transfer = this.device.transferIn(endpoint, transferLength);
				if (result.data?.byteLength)
					this.finishBulkRead(dataViewBytes(result.data));
				if (retire)
					return;
			}
		} catch (error) {
			if (this.opened)
				this.failBulkRead(error);
		} finally {
			this.bulkReadActive--;
		}
	}

	private finishBulkRead(result: Uint8Array): void {
		const receiver = this.bulkReadReceiver;
		if (!receiver) {
			this.bulkReadBuffer.write(result);
			return;
		}
		this.bulkReadReceiver = undefined;
		const count = Math.min(receiver.length, result.length);
		if (count === result.length) {
			receiver.buffer.set(result, receiver.offset);
		} else {
			receiver.buffer.set(result.subarray(0, count), receiver.offset);
			this.bulkReadBuffer.write(result.subarray(count));
		}
		receiver.resolve(count);
	}

	private failBulkRead(error: unknown): void {
		if (this.bulkReadFailure)
			return;
		this.bulkReadFailure = { error };
		const receiver = this.bulkReadReceiver;
		if (receiver) {
			this.bulkReadReceiver = undefined;
			receiver.reject(this.bulkReadFailure.error);
		}
	}

	private startStatusRead(): void {
		const endpoint = this.requireEndpoints().statusEndpoint;
		void this.runStatusRead(endpoint.endpointNumber, endpoint.packetSize);
	}

	private async runStatusRead(endpoint: number, transferLength: number): Promise<void> {
		while (this.opened) {
			let result: USBInTransferResult;
			try {
				result = await this.device.transferIn(endpoint, transferLength);
			} catch (error) {
				if (!this.opened)
					return;
				this.statusError = error;
				// Linux resubmits failed interrupt URBs unless they were cancelled.
				if (!(error instanceof DOMException) || error.name !== 'NetworkError')
					return;
				continue;
			}

			if (!this.opened)
				return;
			try {
				this.updateStatus(result);
				this.statusError = undefined;
			} catch (error) {
				this.statusError = error;
			}
		}
	}

	private updateStatus(result: USBInTransferResult): void {
		const statusIndex = this.deviceInfo.uartStateIndex ?? UART_STATE_INDEX;
		if (result.status !== 'ok' || !result.data)
			throw new WebUSBError(`PL2303 status transfer failed with status ${result.status}`, { cause: result });

		const data = dataViewBytes(result.data);
		if (data.length <= statusIndex)
			throw new WebUSBError(`PL2303 status response is too short: ${data.length}`, { cause: result });
		this.lineStatus = data[statusIndex];
		if ((this.lineStatus & UART_ERROR_MASK) !== 0 && debug.enabled)
			debug('UART error status 0x%s', this.lineStatus.toString(16).padStart(2, '0'));
	}

	private getPortStatus(): PortStatus {
		return {
			cts: (this.lineStatus & UART_CTS) !== 0,
			dsr: (this.lineStatus & UART_DSR) !== 0,
			dcd: (this.lineStatus & UART_DCD) !== 0,
		};
	}

	private async claimInterface(interfaceNumber: number): Promise<void> {
		await this.device.claimInterface(interfaceNumber);
		this.claimedInterfaces.push(interfaceNumber);
	}

	private async detectType(): Promise<PL2303Type> {
		if (this.device.deviceClass === 0x02)
			return 'H';
		if (await this.readMaxPacketSize0() !== 0x40)
			return 'H';

		const usbVersion = bcdVersion(
			this.device.usbVersionMajor,
			this.device.usbVersionMinor,
			this.device.usbVersionSubminor,
		);
		const deviceVersion = bcdVersion(
			this.device.deviceVersionMajor,
			this.device.deviceVersionMinor,
			this.device.deviceVersionSubminor,
		);

		if (usbVersion === 0x0101 || usbVersion === 0x0110) {
			return deviceVersion === 0x0400 ? 'HXD' : 'HX';
		}
		if (usbVersion === 0x0200) {
			switch (deviceVersion) {
				case 0x0300:
					return await this.supportsHXStatus() ? 'TA' : 'HXN';
				case 0x0500:
					return await this.supportsHXStatus() ? 'TB' : 'HXN';
				case 0x0100:
				case 0x0105:
				case 0x0305:
				case 0x0400:
				case 0x0405:
				case 0x0505:
				case 0x0600:
				case 0x0605:
				case 0x0700:
				case 0x0705:
				case 0x0905:
				case 0x1005:
					return 'HXN';
				default:
					if (MP_DEVICE_VERSIONS.includes(deviceVersion))
						return 'MP';
			}
		}

		throw new WebUSBError(
			`Unsupported PL2303 revision: USB ${usbVersion.toString(16)}, device ${deviceVersion.toString(16)}`,
		);
	}

	private async readMaxPacketSize0(): Promise<number> {
		const result = await this.device.controlTransferIn({
			requestType: 'standard',
			recipient: 'device',
			request: REQUEST_GET_DESCRIPTOR,
			value: DEVICE_DESCRIPTOR << 8,
			index: 0,
		}, DEVICE_DESCRIPTOR_HEADER_SIZE);
		if (result.status !== 'ok' || !result.data || result.data.byteLength !== DEVICE_DESCRIPTOR_HEADER_SIZE) {
			throw new WebUSBError(`PL2303 device-descriptor request failed with status ${result.status}`, { cause: result });
		}
		return result.data.getUint8(MAX_PACKET_SIZE_0_INDEX);
	}

	private async supportsHXStatus(): Promise<boolean> {
		try {
			await this.vendorRead(0x8080, REQUEST_VENDOR);
			return true;
		} catch {
			return false;
		}
	}

	private async isHXDClone(): Promise<boolean> {
		const result = await this.getLineRequest();
		if (result.status === 'stall')
			return true;
		if (result.status !== 'ok' || !result.data || result.data.byteLength !== 7)
			throw new WebUSBError(`PL2303 get-line request failed with status ${result.status}`, { cause: result });
		return false;
	}

	private getLineRequest(): Promise<USBInTransferResult> {
		return this.device.controlTransferIn({
			requestType: 'class',
			recipient: 'interface',
			request: REQUEST_GET_LINE,
			value: 0,
			index: 0,
		}, 7);
	}

	private async initializeChip(): Promise<void> {
		const type = this.requireType();
		if (type === 'HXN' || type === 'MP')
			return;

		await this.initializeRequest(this.vendorRead(0x8484));
		await this.initializeRequest(this.vendorWrite(0x0404, 0));
		await this.initializeRequest(this.vendorRead(0x8484));
		await this.initializeRequest(this.vendorRead(0x8383));
		await this.initializeRequest(this.vendorRead(0x8484));
		await this.initializeRequest(this.vendorWrite(0x0404, 1));
		await this.initializeRequest(this.vendorRead(0x8484));
		await this.initializeRequest(this.vendorRead(0x8383));
		await this.initializeRequest(this.vendorWrite(0, 1));
		await this.initializeRequest(this.vendorWrite(1, 0));
		await this.initializeRequest(this.vendorWrite(2, TYPE_DATA[type].legacy ? 0x24 : 0x44));
	}

	private async resetPipes(): Promise<void> {
		const type = this.requireType();
		const endpoints = this.requireEndpoints();
		if (TYPE_DATA[type].legacy) {
			await this.device.clearHalt('out', endpoints.outEndpoint.endpointNumber);
			await this.device.clearHalt('in', endpoints.inEndpoint.endpointNumber);
		} else if (type === 'HXN') {
			await this.vendorWrite(HXN_RESET_REG, HXN_RESET_BOTH_PIPES);
		} else if (type === 'MP') {
			await this.controlOut(
				'vendor',
				REQUEST_RESET_MP,
				0,
				endpoints.dataInterface,
			);
		} else {
			await this.vendorWrite(8, 0);
			await this.vendorWrite(9, 0);
		}
	}

	private async configure(options: USBSerialOpenOptions): Promise<number> {
		const type = this.requireType();
		if (!this.noBreakGetLine) {
			try {
				const result = await this.getLineRequest();
				if (result.status !== 'ok' || result.data?.byteLength !== 7)
					throw new WebUSBError(`PL2303 get-line request failed with status ${result.status}`, { cause: result });
			} catch (error) {
				// Linux continues set_termios after a failed GET_LINE; all seven bytes are replaced.
				if (debug.enabled)
					debug('get-line before configuration failed: %O', error);
			}
		}
		const lineCoding = createPL2303LineCoding(options, type);
		if (debug.enabled) {
			debug(
				'configure baudRate=%d dataBits=%d stopBits=%s parity=%s rtscts=%s xon=%s xoff=%s',
				lineCoding.baudRate,
				options.dataBits,
				options.stopBits,
				options.parity,
				options.rtscts,
				options.xon,
				options.xoff,
			);
		}
		// Reapplying identical line settings can lose bytes on PL2303 (Linux set_termios).
		const previousSettings = this.lineSettings;
		if (!previousSettings || lineCoding.data.some((byte, index) => byte !== previousSettings[index])) {
			const applied = await this.ignoreStalledRequest(
				this.controlOut(
					'class',
					REQUEST_SET_LINE,
					0,
					0,
					lineCoding.data,
				),
				'set line coding',
			);
			if (applied)
				this.lineSettings = lineCoding.data;
		}
		await this.ignoreStalledRequest(this.configureFlowControl(options), 'configure flow control');
		return lineCoding.baudRate;
	}

	private async configureFlowControl(options: USBSerialOpenOptions): Promise<void> {
		const type = this.requireType();
		const typeData = TYPE_DATA[type];
		let value = 0;

		if (options.rtscts) {
			if (typeData.legacy)
				value = 0x40;
			else if (type === 'HXN')
				value = HXN_FLOW_CONTROL_RTS_CTS;
			else if (type === 'MP')
				value = MP_FLOW_CONTROL_RTS_CTS;
			else
				value = 0x60;
		} else if (options.xon && !options.xany && !typeData.noAutoXonXoff) {
			if (type === 'HXN')
				value = HXN_FLOW_CONTROL_XON_XOFF;
			else if (type === 'MP')
				value = MP_FLOW_CONTROL_XON_XOFF;
			else
				value = 0xC0;
		} else if (type === 'HXN') {
			value = HXN_FLOW_CONTROL_NONE;
		} else if (type === 'MP') {
			value = MP_FLOW_CONTROL_NONE;
		}

		if (type === 'HXN') {
			await this.updateRegister(HXN_FLOW_CONTROL_REG, HXN_FLOW_CONTROL_MASK, value);
		} else if (type === 'MP') {
			await this.vendorWrite(this.getMPFlowControlRegister(), value);
		} else {
			await this.updateRegister(0, FLOW_CONTROL_MASK, value);
		}
	}

	private async updateRegister(register: number, mask: number, value: number): Promise<void> {
		const type = this.requireType();
		const current = await this.vendorRead(type === 'HXN' || type === 'MP' ? register : register | 0x80);
		await this.vendorWrite(register, (current & ~mask) | (value & mask));
	}

	private async setControlLines(): Promise<void> {
		await this.controlOut(
			'class',
			REQUEST_SET_CONTROL,
			this.lineControl,
			0,
		);
	}

	private async setBreak(enabled: boolean): Promise<void> {
		if (this.noBreakGetLine)
			throw new WebUSBError('Break control is not supported by this PL2303 clone');
		await this.controlOut(
			'class',
			REQUEST_BREAK,
			enabled ? BREAK_ON : BREAK_OFF,
			0,
		);
	}

	private async initializeRequest(request: Promise<unknown>): Promise<void> {
		try {
			await request;
		} catch (error) {
			if (debug.enabled)
				debug('initialization request failed: %O', error);
		}
	}

	private async ignoreStalledRequest(request: Promise<void>, operation: string): Promise<boolean> {
		try {
			await request;
			return true;
		} catch (error) {
			if (!isStalledTransfer(error))
				throw error;
			if (debug.enabled)
				debug('%s request is not supported', operation);
			return false;
		}
	}

	private async vendorRead(value: number, request?: number): Promise<number> {
		let vendorRequest = request;
		if (vendorRequest === undefined) {
			const type = this.requireType();
			if (type === 'HXN')
				vendorRequest = REQUEST_VENDOR_READ_N;
			else if (type === 'MP')
				vendorRequest = REQUEST_VENDOR_READ_MP;
			else
				vendorRequest = REQUEST_VENDOR;
		}

		const result = await this.device.controlTransferIn({
			requestType: 'vendor',
			recipient: 'device',
			request: vendorRequest,
			value,
			index: 0,
		}, 1);
		if (result.status !== 'ok' || !result.data || result.data.byteLength !== 1)
			throw new WebUSBError(`PL2303 vendor read 0x${value.toString(16)} failed with status ${result.status}`, { cause: result });
		return result.data.getUint8(0);
	}

	private async vendorWrite(value: number, index: number): Promise<void> {
		const type = this.requireType();
		await this.controlOut(
			'vendor',
			type === 'HXN' || type === 'MP' ? REQUEST_VENDOR_N : REQUEST_VENDOR,
			value,
			index,
		);
	}

	private async controlOut(
		requestType: USBRequestType,
		request: number,
		value: number,
		index: number,
		data = new Uint8Array(0),
	): Promise<void> {
		const result = await this.device.controlTransferOut({
			requestType,
			recipient: requestType === 'class' ? 'interface' : 'device',
			request,
			value,
			index,
		}, data);
		if (result.status !== 'ok')
			throw new WebUSBError(`PL2303 control request 0x${request.toString(16)} failed with status ${result.status}`, { cause: result });
		if (result.bytesWritten !== data.byteLength) {
			throw new WebUSBError(
				`PL2303 control request 0x${request.toString(16)} wrote ${result.bytesWritten} of ${data.byteLength} bytes`,
				{ cause: result },
			);
		}
	}

	private requireEndpoints(): PL2303Endpoints {
		if (!this.endpoints)
			throw new WebUSBError('PL2303 endpoints are not initialized');
		return this.endpoints;
	}

	private requireType(): PL2303Type {
		if (!this.type)
			throw new WebUSBError('PL2303 type is not initialized');
		return this.type;
	}

	private requireOptions(): USBSerialOpenOptions {
		if (!this.options)
			throw new WebUSBError('PL2303 options are not initialized');
		return this.options;
	}

	private getMPFlowControlRegister(): number {
		const interfaceNumber = this.requireEndpoints().dataInterface;
		const register = MP_FLOW_CONTROL_REGISTERS[interfaceNumber];
		if (register === undefined)
			throw new WebUSBError(`PL256X does not support interface ${interfaceNumber}`);
		return register;
	}

	private async cleanupAfterFailedOpen(): Promise<void> {
		for (const interfaceNumber of [...this.claimedInterfaces].reverse()) {
			try {
				await this.device.releaseInterface(interfaceNumber);
			} catch {
				// Preserve the original open error.
			}
		}
		try {
			await this.device.close();
		} catch {
			// Preserve the original open error.
		}
		this.claimedInterfaces = [];
	}
}
