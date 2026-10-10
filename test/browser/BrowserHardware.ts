import { chromium, expect, test, type Page, type TestInfo } from '@playwright/test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getDeviceList, type Device } from 'usb';
import { listUSBPorts } from '../../src/discovery.js';
import {
	hardwareTestsEnabled,
	readHardwareSelector,
	type HardwareSelector,
} from '../HardwareConfig.js';
import { HardwareWebUSB } from '../hardware/HardwareWebUSB.js';
import {
	attachKernelDrivers,
	detachKernelDrivers,
	findUSBDeviceAt,
} from '../hardware/KernelDriver.js';

const browserOrigin = 'http://127.0.0.1:4173';

function formatUSBId(target: HardwareSelector): string {
	return `${target.vendorId.toString(16).padStart(4, '0')}:${target.productId.toString(16).padStart(4, '0')}`;
}

async function findHardwareDevices(
	selector?: HardwareSelector,
): Promise<Array<{ device: Device, target: HardwareSelector }>> {
	const provider = new HardwareWebUSB();
	const ports = await listUSBPorts(provider);
	const availableDevices = [...new Set(ports.map(port => port.nativeDevice))];
	const devices = availableDevices.filter(device => {
		if (!selector)
			return true;
		if (device.vendorId !== selector.vendorId || device.productId !== selector.productId)
			return false;
		if (selector.serialNumber !== undefined && device.serialNumber !== selector.serialNumber)
			return false;
		return selector.busNumber === undefined ||
			provider.locationOf(device).busNumber === selector.busNumber;
	});
	if (devices.length === 0) {
		if (selector)
			throw new Error(`USB device ${formatUSBId(selector)} was not found`);
		throw new Error('No supported USB serial devices were found');
	}
	if (selector && devices.length > 1)
		throw new Error(`USB device ${formatUSBId(selector)} is ambiguous; set WEBUSB_BUS or WEBUSB_SERIAL`);
	return devices.map(device => {
		const target = {
			vendorId: device.vendorId,
			productId: device.productId,
			serialNumber: device.serialNumber || undefined,
		};
		if (
			target.serialNumber === undefined &&
			availableDevices.some(candidate =>
				candidate !== device &&
				candidate.vendorId === device.vendorId &&
				candidate.productId === device.productId,
			)
		) {
			throw new Error('Browser WebUSB cannot distinguish identical devices without serial numbers');
		}
		const location = provider.locationOf(device);
		const nativeDevice = findUSBDeviceAt(location.busNumber, location.portNumbers);
		if (!nativeDevice)
			throw new Error(`USB device ${formatUSBId(target)} disappeared`);
		return { device: nativeDevice, target };
	});
}

async function selectUSBDevice(page: Page): Promise<void> {
	const permittedDeviceCount = await page.evaluate(async () => (await navigator.usb.getDevices()).length);
	if (permittedDeviceCount === 0)
		throw new Error('Headless Chromium has no WebUSB permission for the selected device');
	await page.getByRole('button', { name: 'Select USB device' }).click();
	await expect(page.locator('#status')).toHaveText('selected');
}

export async function withHardwareBrowser<T>(
	targets: readonly HardwareSelector[],
	run: (page: Page) => Promise<T>,
): Promise<T> {
	const profilePath = await mkdtemp(join(tmpdir(), 'webusb-playwright-'));
	const defaultProfilePath = join(profilePath, 'Default');
	await mkdir(defaultProfilePath);
	await writeFile(join(defaultProfilePath, 'Preferences'), JSON.stringify({
		profile: {
			managed_web_usb_allow_devices_for_urls: [{
				devices: targets.map(target => ({
					vendor_id: target.vendorId,
					product_id: target.productId,
				})),
				urls: [browserOrigin],
			}],
		},
	}));
	try {
		const context = await chromium.launchPersistentContext(profilePath, {
			baseURL: browserOrigin,
			channel: 'chrome',
			headless: true,
		});
		try {
			const page = await context.newPage();
			return await run(page);
		} finally {
			await context.close();
		}
	} finally {
		await rm(profilePath, { recursive: true, force: true });
	}
}

export async function configureHardwarePage(page: Page): Promise<string[]> {
	const errors: string[] = [];
	page.on('pageerror', error => errors.push(error.stack ?? error.message));
	const debug = process.env.DEBUG;
	if (debug) {
		page.on('console', message => console.log(`[browser] ${message.text()}`));
		await page.addInitScript(value => localStorage.debug = value, debug);
	}
	const cpuThrottlingRate = Number(process.env.WEBUSB_CPU_THROTTLING_RATE ?? '1');
	if (!Number.isFinite(cpuThrottlingRate) || cpuThrottlingRate < 1)
		throw new Error('WEBUSB_CPU_THROTTLING_RATE must be a finite number >= 1');
	if (cpuThrottlingRate !== 1) {
		const session = await page.context().newCDPSession(page);
		await session.send('Emulation.setCPUThrottlingRate', { rate: cpuThrottlingRate });
		await session.detach();
	}
	return errors;
}

export async function openHardwarePage(
	page: Page,
	target: HardwareSelector,
): Promise<void> {
	const query = new URLSearchParams({ device: formatUSBId(target) });
	if (target.serialNumber !== undefined)
		query.set('serial', target.serialNumber);
	await page.goto(`/?${query}`);
	await selectUSBDevice(page);
}

async function withKernelDrivers<T>(devices: readonly Device[], run: () => Promise<T>): Promise<T> {
	const detached: Array<{ device: Device, interfaces: number[] }> = [];
	try {
		for (const device of devices)
			detached.push({ device, interfaces: detachKernelDrivers(device) });
		return await run();
	} finally {
		for (const { device, interfaces } of detached) {
			if (getDeviceList().includes(device))
				attachKernelDrivers(device, interfaces);
		}
	}
}

function defineHardwareTest(
	title: string,
	timeout: number,
	requireDevice: boolean,
	run: (page: Page, testInfo: TestInfo) => Promise<void>,
): void {
	test(title, async ({}, testInfo) => {
		test.skip(!hardwareTestsEnabled(), 'Browser hardware tests are disabled');
		test.setTimeout(timeout);
		const selector = readHardwareSelector();
		if (requireDevice && !selector)
			throw new Error('WEBUSB_DEV is required for this hardware test');
		const devices = await findHardwareDevices(selector);
		test.setTimeout(timeout * devices.length);
		await withKernelDrivers(devices.map(({ device }) => device), () =>
			withHardwareBrowser(devices.map(({ target }) => target), async page => {
				const errors = await configureHardwarePage(page);
				for (const { target } of devices) {
					await openHardwarePage(page, target);
					await run(page, testInfo);
				}
				expect(errors).toEqual([]);
			}),
		);
	});
}

export function hardwareTest(
	title: string,
	timeout: number,
	run: (page: Page, testInfo: TestInfo) => Promise<void>,
): void {
	defineHardwareTest(title, timeout, false, run);
}

export function selectedHardwareTest(
	title: string,
	timeout: number,
	run: (page: Page, testInfo: TestInfo) => Promise<void>,
): void {
	defineHardwareTest(title, timeout, true, run);
}
