import { createWebUSBBinding } from './binding.js';
import { WebUSBError } from './WebUSBError.js';

function getBrowserUSB(): USB {
	if (typeof navigator === 'undefined' || !navigator.usb)
		throw new WebUSBError('WebUSB is not available in this browser');
	return navigator.usb;
}

export const WebUSBBinding = createWebUSBBinding(getBrowserUSB);
export type {
	WebUSBBindingInterface,
	WebUSBOpenOptions,
	WebUSBPortBinding,
	WebUSBPortInfo,
} from './types.js';
export default WebUSBBinding;
