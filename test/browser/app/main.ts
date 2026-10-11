import { WebUSBBinding, type WebUSBPortInfo } from '../../../src/index.js';
import { WEBUSB_SERIAL_FILTERS } from '../../../src/drivers/registry.js';
import { loopbackBaudRates, type StressLoopbackResult } from '../../Loopback.js';
import { USBSerialDevice, type USBSerialDeviceKind } from '../../USBSerialDevice.js';
import { WebUSBEmulator } from '../../WebUSBEmulator.js';
import {
	restoreWorkerError,
	type TestWorkerCommand,
	type TestWorkerReply,
	type TestWorkerResponse,
} from '../TestWorkerProtocol.js';

interface ChaosResult {
	bytesRead: number;
	distinctBytes: number;
}

type BFCResult = Extract<TestWorkerReply, { type: 'bfc' }>['result'];

export interface BrowserUSBTestAPI {
	runLoopback(): Promise<void>;
	loopbackBaudRates(): readonly number[];
	runStressLoopback(baudRate?: number): Promise<StressLoopbackResult>;
	runAT(): Promise<string[]>;
	runBFC(): Promise<BFCResult>;
	runChaos(): Promise<ChaosResult>;
}

declare global {
	interface Window {
		browserUSBTest: BrowserUSBTestAPI;
	}
}

const query = new URLSearchParams(location.search);
const emulatorKind = getEmulatorKind(query.get('emulator'));
const emulatedDevice = emulatorKind ? new USBSerialDevice(emulatorKind) : undefined;
const requestedDeviceId = query.get('device');
const requestedSerialNumber = query.get('serial') ?? undefined;
if (emulatedDevice) {
	Object.defineProperty(navigator, 'usb', {
		value: new WebUSBEmulator([emulatedDevice]),
		configurable: true,
	});
}

function getEmulatorKind(value: string | null): USBSerialDeviceKind | undefined {
	switch (value) {
		case '1':
		case 'pl2303':
			return 'pl2303';
		case 'ch341':
		case 'cp210x':
		case 'ftdi':
		case 'cdc-acm':
			return value;
		case null:
			return undefined;
		default:
			throw new Error(`Unknown USB emulator kind: ${value}`);
	}
}

const selectButton = document.querySelector<HTMLButtonElement>('#select-device');
const status = document.querySelector<HTMLOutputElement>('#status');
if (!selectButton || !status)
	throw new Error('Browser test controls were not found');
const browserStatus = status;

let selectedPort: WebUSBPortInfo | undefined;

selectButton.addEventListener('click', async () => {
	status.value = 'selecting';
	try {
		selectedPort = await requestPort(requestedDeviceId, requestedSerialNumber);
		status.value = 'selected';
	} catch (error) {
		status.value = `error: ${error}`;
	}
});

async function requestPort(
	deviceId: string | null,
	serialNumber?: string,
): Promise<WebUSBPortInfo> {
	let filters: USBDeviceFilter[] = [...WEBUSB_SERIAL_FILTERS];
	let requestedVendorId: number | undefined;
	let requestedProductId: number | undefined;
	if (deviceId !== null) {
		if (!/^[0-9A-F]{4}:[0-9A-F]{4}$/i.test(deviceId))
			throw new Error(`Invalid USB device ID: ${deviceId}`);
		const [vendorId, productId] = deviceId.split(':').map(value => Number.parseInt(value, 16));
		requestedVendorId = vendorId;
		requestedProductId = productId;
		filters = [{ vendorId, productId, serialNumber }];
	}
	const permitted = (await navigator.usb.getDevices()).filter(device =>
		(requestedVendorId === undefined || device.vendorId === requestedVendorId) &&
		(requestedProductId === undefined || device.productId === requestedProductId) &&
		(serialNumber === undefined || device.serialNumber === serialNumber),
	);
	const device = permitted.length === 1 ?
		permitted[0] :
		await navigator.usb.requestDevice({ filters });
	const port = (await WebUSBBinding.list()).find(candidate => candidate.nativeDevice === device);
	if (!port)
		throw new Error('Selected USB device has no supported serial interface');
	return port;
}

function executeWorker(command: TestWorkerCommand): Promise<TestWorkerReply> {
	const worker = new Worker(new URL('./testWorker.ts', import.meta.url), { type: 'module' });
	return new Promise((resolve, reject) => {
		const close = () => worker.terminate();
		worker.onmessage = (event: MessageEvent<TestWorkerResponse>) => {
			const response = event.data;
			if (response.type === 'stage') {
				browserStatus.value = response.stage;
				return;
			}
			if (response.type === 'progress') {
				browserStatus.value = `progress:${response.bytesRead}`;
				return;
			}
			close();
			if (response.type === 'error') {
				reject(restoreWorkerError(response.error));
			} else {
				resolve(response.result);
			}
		};
		worker.onerror = event => {
			close();
			reject(new Error(event.message));
		};
		worker.postMessage(command);
	});
}

function workerOptions(): { path: string, emulatorKind?: USBSerialDeviceKind } {
	if (!selectedPort)
		throw new Error('No USB device was selected');
	return { path: selectedPort.path, emulatorKind };
}

async function runLoopback(): Promise<void> {
	const result = await executeWorker({
		type: 'loopback',
		baudRate: 115200,
		...workerOptions(),
	});
	if (result.type !== 'loopback')
		throw new Error('Unexpected loopback worker reply');
}

async function runStressLoopback(baudRate = 115200): Promise<StressLoopbackResult> {
	const result = await executeWorker({
		type: 'stress-loopback',
		baudRate,
		...workerOptions(),
	});
	if (result.type !== 'stress-loopback')
		throw new Error('Unexpected stress-loopback worker reply');
	return result.result;
}

async function runAT(): Promise<string[]> {
	const result = await executeWorker({ type: 'at', ...workerOptions() });
	if (result.type !== 'at')
		throw new Error('Unexpected AT worker reply');
	return result.statuses;
}

async function runBFC(): Promise<BFCResult> {
	const result = await executeWorker({ type: 'bfc', ...workerOptions() });
	if (result.type !== 'bfc')
		throw new Error('Unexpected BFC worker reply');
	return result.result;
}

async function runChaos(): Promise<ChaosResult> {
	const result = await executeWorker({ type: 'chaos', ...workerOptions() });
	if (result.type !== 'chaos')
		throw new Error('Unexpected Chaos worker reply');
	return { bytesRead: result.bytesRead, distinctBytes: result.distinctBytes };
}

window.browserUSBTest = {
	runLoopback,
	loopbackBaudRates: () => selectedPort ? loopbackBaudRates(selectedPort.nativeDevice) : [],
	runStressLoopback,
	runAT,
	runBFC,
	runChaos,
};
