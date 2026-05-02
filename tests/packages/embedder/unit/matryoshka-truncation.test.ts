/**
 * Unit tests: Matryoshka head-truncation + L2 renormalization.
 *
 * Pure math, no I/O. Validates the slice-and-renormalize step that
 * lets us bring a 2560-d Qwen3-4B vector down to a 2048-d float row
 * stored in `vec_claw_memories(float[2048])` while keeping cosine
 * similarity meaningful.
 */

import { describe, expect, it } from "vitest";
import { truncateAndRenormalize } from "@snoai/embedder";

const TOL = 1e-6;

function l2(v: number[]): number {
	let s = 0;
	for (const x of v) s += x * x;
	return Math.sqrt(s);
}

function dot(a: number[], b: number[]): number {
	let s = 0;
	for (let i = 0; i < a.length; i++) {
		s += (a[i] ?? 0) * (b[i] ?? 0);
	}
	return s;
}

describe("truncateAndRenormalize", () => {
	it("returns a unit-norm vector of the requested length", () => {
		// Native vector of length 2560 with arbitrary values; exact magnitude
		// is irrelevant because the function re-normalizes.
		const native = Array.from({ length: 2560 }, (_, i) => Math.sin(i * 0.13));
		const out = truncateAndRenormalize(native, 2048);

		expect(out.length).toBe(2048);
		expect(Math.abs(l2(out) - 1)).toBeLessThan(TOL);
	});

	it("preserves the leading-prefix direction of the native vector", () => {
		// Build a native unit vector from the same head as `out`, just
		// to confirm we kept the leading 2048 floats and only rescaled.
		const native = Array.from({ length: 2560 }, (_, i) => Math.cos(i * 0.07));

		const out = truncateAndRenormalize(native, 2048);

		// The renormalized prefix should be parallel (cosine = 1) to the
		// raw prefix interpreted as a vector.
		const rawPrefix = native.slice(0, 2048);
		const rawNorm = l2(rawPrefix);
		const cosine = dot(out, rawPrefix) / rawNorm;
		expect(Math.abs(cosine - 1)).toBeLessThan(TOL);
	});

	it("is a no-op (modulo copy) when outputDim equals nativeDim", () => {
		// A unit-norm 1024-d vector should come out identical because the
		// renorm step divides by 1.
		const native = Array.from({ length: 1024 }, () => 1 / Math.sqrt(1024));
		const out = truncateAndRenormalize(native, 1024);
		expect(out.length).toBe(1024);
		// Allow a minute floating-point drift from the renormalization step.
		for (let i = 0; i < 1024; i++) {
			expect(Math.abs((out[i] ?? 0) - (native[i] ?? 0))).toBeLessThan(TOL);
		}
		expect(Math.abs(l2(out) - 1)).toBeLessThan(TOL);
	});

	it("handles a zero-norm prefix without dividing by zero", () => {
		// First 2048 entries are zero; remainder is arbitrary. The function
		// should return the (still-zero) prefix instead of producing NaNs.
		const native = new Array<number>(2560).fill(0);
		for (let i = 2048; i < 2560; i++) native[i] = 0.5;
		const out = truncateAndRenormalize(native, 2048);
		expect(out.length).toBe(2048);
		for (const x of out) expect(x).toBe(0);
	});

	it("rejects outputDim out of range", () => {
		const native = Array.from({ length: 1024 }, () => 0.1);
		expect(() => truncateAndRenormalize(native, 0)).toThrow();
		expect(() => truncateAndRenormalize(native, -1)).toThrow();
		expect(() => truncateAndRenormalize(native, 1025)).toThrow();
	});
});
