import { createWebUSBBinding } from './binding.js';
import { NodeWebUSB } from './NodeWebUSB.js';

let provider: NodeWebUSB | undefined;

function getNodeUSB(): USB {
	provider ??= new NodeWebUSB();
	return provider;
}

export { WEBUSB_SERIAL_FILTERS } from './drivers/registry.js';
export const WebUSBBinding = createWebUSBBinding(getNodeUSB);
export type {
	WebUSBBindingInterface,
	WebUSBOpenOptions,
	WebUSBPortBinding,
	WebUSBPortInfo,
} from './types.js';
export default WebUSBBinding;
