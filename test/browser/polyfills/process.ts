import browserProcess from 'browser-process-base';
import { nextTick } from './nextTick.js';

export { nextTick };
export const process = { ...browserProcess, nextTick };
export default process;
