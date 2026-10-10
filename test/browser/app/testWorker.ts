import { SerialPortStream } from '@serialport/stream';
import { AsyncSerialPort } from '@sie-js/serial';
import { createWebUSBBinding } from '../../../src/binding.js';
import {
	WebUSBBinding,
	type WebUSBBindingInterface,
	type WebUSBPortBinding,
} from '../../../src/index.js';
import { runLoopbackSuite, runStressLoopbackSuite } from '../../Loopback.js';
import { exchangeAT, readBFC, readChaosMemory } from '../../PhoneTests.js';
import { USBSerialDevice } from '../../USBSerialDevice.js';
import { WebUSBEmulator } from '../../WebUSBEmulator.js';
import {
	serializeWorkerError,
	type TestWorkerCommand,
	type TestWorkerReply,
	type TestWorkerResponse,
} from '../TestWorkerProtocol.js';

function reply(message: TestWorkerResponse): void {
	globalThis.postMessage(message);
}

function bindingFor(command: TestWorkerCommand): WebUSBBindingInterface {
	if (!command.emulatorKind)
		return WebUSBBinding;
	const device = new USBSerialDevice(command.emulatorKind);
	return createWebUSBBinding(() => new WebUSBEmulator([device]));
}

async function withBinding<T>(
	command: TestWorkerCommand,
	baudRate: number,
	run: (binding: WebUSBPortBinding) => Promise<T>,
): Promise<T> {
	reply({ type: 'stage', stage: 'opening' });
	const binding = await bindingFor(command).open({ path: command.path, baudRate });
	reply({ type: 'stage', stage: 'running' });
	try {
		return await run(binding);
	} finally {
		await binding.close();
	}
}

async function withPort<T>(
	command: TestWorkerCommand,
	run: (port: AsyncSerialPort<WebUSBBindingInterface>) => Promise<T>,
): Promise<T> {
	reply({ type: 'stage', stage: 'opening' });
	const nativePort = new SerialPortStream<WebUSBBindingInterface>({
		binding: bindingFor(command),
		path: command.path,
		baudRate: 115200,
		autoOpen: false,
	});
	const port = new AsyncSerialPort(nativePort);
	await port.open();
	reply({ type: 'stage', stage: 'running' });
	try {
		return await run(port);
	} finally {
		if (port.isOpen)
			await port.close();
	}
}

async function execute(command: TestWorkerCommand): Promise<TestWorkerReply> {
	switch (command.type) {
		case 'loopback':
			return withBinding(command, command.baudRate, async binding => {
				await runLoopbackSuite(binding);
				return { type: 'loopback' };
			});
		case 'stress-loopback':
			return withBinding(command, command.baudRate, async binding => ({
				type: 'stress-loopback',
				result: await runStressLoopbackSuite(binding),
			}));
		case 'at':
			return withPort(command, async port => ({ type: 'at', statuses: await exchangeAT(port) }));
		case 'bfc':
			return withPort(command, async port => ({
				type: 'bfc',
				result: await readBFC(port, bytesRead => {
					reply({ type: 'progress', bytesRead });
				}),
			}));
		case 'chaos':
			return withPort(command, async port => {
				const result = await readChaosMemory(port, 0xA0000000, 1024 * 1024, 1625000);
				return {
					type: 'chaos',
					bytesRead: result.length,
					distinctBytes: new Set(result).size,
				};
			});
	}
}

globalThis.onmessage = (event: MessageEvent<TestWorkerCommand>) => {
	void execute(event.data).then(
		result => reply({ type: 'result', result }),
		error => reply({ type: 'error', error: serializeWorkerError(error) }),
	);
};
