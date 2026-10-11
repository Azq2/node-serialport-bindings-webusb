import { expect, it } from 'vitest';
import { ByteRingBuffer } from '../src/ByteRingBuffer.js';

function read(ring: ByteRingBuffer, length: number): number[] {
	const target = new Uint8Array(length);
	return [...target.subarray(0, ring.read(target, 0, length))];
}

it('wraps around the end of the buffer', () => {
	const ring = new ByteRingBuffer(4);
	ring.write(Uint8Array.of(1, 2, 3));
	expect(read(ring, 2)).toEqual([1, 2]);
	ring.write(Uint8Array.of(4, 5, 6));
	expect(read(ring, 10)).toEqual([3, 4, 5, 6]);
	expect(read(ring, 1)).toEqual([]);
});

it('grows while keeping wrapped bytes in order', () => {
	const ring = new ByteRingBuffer(4);
	ring.write(Uint8Array.of(1, 2, 3));
	expect(read(ring, 2)).toEqual([1, 2]);
	ring.write(Uint8Array.of(4, 5));
	ring.write(Uint8Array.of(6, 7, 8, 9, 10));
	expect(read(ring, 3)).toEqual([3, 4, 5]);
	ring.write(Uint8Array.of(11));
	expect(read(ring, 10)).toEqual([6, 7, 8, 9, 10, 11]);
});

it('reads into a target offset and clears', () => {
	const ring = new ByteRingBuffer(2);
	ring.write(Uint8Array.of(7, 8));
	const target = new Uint8Array(4);
	expect(ring.read(target, 1, 1)).toBe(1);
	expect([...target]).toEqual([0, 7, 0, 0]);
	ring.clear();
	expect(read(ring, 1)).toEqual([]);
});
