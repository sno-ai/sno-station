/** @file session-strategy.ts
 * @purpose Defines session-memory strategy constants without importing plugin config schemas.
 * @boundary Shared literal values only; no schema or runtime registration dependencies.
 */

export const SESSION_STRATEGIES = ["memoryReflection", "systemSessionMemory", "none"] as const;

export type SessionStrategy = (typeof SESSION_STRATEGIES)[number];
