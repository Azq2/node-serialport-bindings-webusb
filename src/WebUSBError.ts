import type { BindingsErrorInterface } from '@serialport/bindings-interface' with { 'resolution-mode': 'require' };

export class WebUSBError extends Error implements BindingsErrorInterface {
	canceled?: boolean;

	constructor(message: string, options?: ErrorOptions & { canceled?: boolean }) {
		super(message, options);
		this.name = 'WebUSBError';
		this.canceled = options?.canceled;
	}
}

export function canceledError(message: string, cause?: unknown): WebUSBError {
	return new WebUSBError(message, { canceled: true, cause });
}
