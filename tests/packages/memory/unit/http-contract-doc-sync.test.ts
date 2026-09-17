/**
 * HTTP-CONTRACT.md format: unique <!-- table:NAME --> markers, immediately followed
 * by a pipe table with one header and one separator row. Cells escape pipes as
 * &#124; and newlines as &#10;. No inline Markdown in machine-checked cells.
 * routes: Contract method | Method | Path | Deadline ms.
 * request:METHOD / response:METHOD: Field | Type | Required | Enum | Default | Constraints.
 * Dotted paths are nested fields, [] denotes items, {} denotes record values,
 * <N> denotes a zero-based union branch; its discriminant row names that branch.
 * Required is relative to the containing object. '-' means absent, not a default.
 * errors: Reason | HTTP status. Per-route errors:METHOD uses the same format.
 * example:METHOD:request/response markers precede exactly one JSON code fence.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { z } from "zod";
import {
	contractJsonSchemas, inputSchemas, outputSchemas, MEMORY_ROUTES, MEMORY_ERROR_STATUS, DEGRADED_REASONS,
} from "../../../../packages/sno-station-mem/src/contract/index";
import { SNO_OBSERVE_DEFAULT_BASE_URL } from "../../../../packages/sno-station-mem/config/index";

type Schema = z.core.JSONSchema.JSONSchema;
type Row = string[];
const document = readFileSync(new URL("../../../../packages/sno-station-mem/src/contract/HTTP-CONTRACT.md", import.meta.url), "utf8");
const methods = Object.keys(MEMORY_ROUTES) as Array<keyof typeof MEMORY_ROUTES>;

function table(name: string): Row[] {
	const marker = `<!-- table:${name} -->\n`;
	expect(document.split(marker), `unique table ${name}`).toHaveLength(2);
	const tail = document.split(marker)[1];
	if (tail === undefined) throw new Error(`Missing table ${name}`);
	const lines = tail.split("\n");
	const rows = lines.slice(2).slice(0, lines.slice(2).findIndex(line => !line.startsWith("|")));
	const header = name === "routes" ? "| Contract method | Method | Path | Deadline ms |"
		: name.startsWith("errors") ? "| Reason | HTTP status |"
		: "| Field | Type | Required | Enum | Default | Constraints |";
	expect(lines[0], `${name} header`).toBe(header);
	expect(lines[1], `${name} separator`).toMatch(/^\|(?: --- \|)+$/);
	return rows.map(line => line.slice(1, -1).split("|").map(cell => cell.trim()
		.replaceAll("&#124;", "|").replaceAll("&#10;", "\n")));
}

function equalRows(actual: Row[], expected: Row[], name: string): void {
	const keys = actual.map(row => row[0]);
	expect(new Set(keys).size, `${name}: duplicate field/reason`).toBe(keys.length);
	for (const row of expected) {
		expect(actual.find(candidate => candidate[0] === row[0]), `${name}: ${row[0]}`).toEqual(row);
	}
	expect(keys.sort(), `${name}: extra field/reason`).toEqual(expected.map(row => row[0]).sort());
}

function schemaRows(schema: Schema, field = "$", required = true): Row[] {
	const variants = schema.oneOf ?? schema.anyOf;
	const omitted = new Set(["$schema", "$defs", "type", "properties", "required", "items",
		"oneOf", "anyOf", "enum", "const", "default", "additionalProperties", "$ref"]);
	const constraints = Object.fromEntries(Object.entries(schema).filter(([key]) => !omitted.has(key)));
	if (schema.additionalProperties === false) constraints.additionalProperties = false;
	const values = schema.enum ?? ("const" in schema ? [schema.const] : undefined);
	let defaultValue = "default" in schema ? JSON.stringify(schema.default) : "-";
	if (field === "registration.settings.observe.enabled") defaultValue = "SNO_OBSERVE_ENABLED (true/1; otherwise false)";
	if (field === "registration.settings.observe.baseUrl") defaultValue = `SNO_OBSERVE_BASE_URL or ${SNO_OBSERVE_DEFAULT_BASE_URL}`;
	const rows: Row[] = [[field, schema.$ref ? "JSON" : Array.isArray(schema.type)
		? schema.type.join(" or ") : schema.type ?? (variants ? "union" : "unknown"),
		required ? "yes" : "no", values ? JSON.stringify(values) : "-",
		defaultValue,
		Object.keys(constraints).length ? JSON.stringify(constraints) : "-"]];
	for (const [key, child] of Object.entries(schema.properties ?? {})) {
		if (typeof child === "boolean") throw new Error(`Unsupported boolean schema: ${field}.${key}`);
		rows.push(...schemaRows(child, field === "$" ? key : `${field}.${key}`, schema.required?.includes(key) ?? false));
	}
	if (schema.items && !Array.isArray(schema.items) && typeof schema.items !== "boolean") {
		rows.push(...schemaRows(schema.items, `${field}[]`));
	}
	if (schema.additionalProperties && typeof schema.additionalProperties !== "boolean") {
		rows.push(...schemaRows(schema.additionalProperties, `${field}{}`));
	}
	variants?.forEach((child, index) => {
		if (typeof child === "boolean") throw new Error(`Unsupported union schema: ${field}`);
		rows.push(...schemaRows(child, `${field}<${index}>`));
	});
	return rows;
}

function example(method: string, direction: string): unknown {
	const marker = `<!-- example:${method}:${direction} -->\n\`\`\`json\n`;
	expect(document.split(marker), `unique ${method} ${direction} example`).toHaveLength(2);
	const body = document.split(marker)[1]?.split("\n```")[0];
	if (body === undefined) throw new Error(`Missing ${method} ${direction} example`);
	return JSON.parse(body);
}

describe("sidecar API reference stays in sync", () => {
	it("lists exactly the memory methods, paths and server deadlines", () => {
		equalRows(table("routes"), methods.map(method => [method, "POST", MEMORY_ROUTES[method].path,
			String(MEMORY_ROUTES[method].timeoutMs)]), "routes");
	});
	it("lists every closed error reason and its HTTP status", () => {
		equalRows(table("errors"), Object.entries(MEMORY_ERROR_STATUS).map(([reason, status]) => [reason, String(status)]), "errors");
		expect(table("errors").map(row => row[0]).sort()).toEqual([...DEGRADED_REASONS].sort());
	});
	for (const method of methods) {
		it(`${method}: request fields, required-ness, enums, defaults and nested variants`, () => {
			const rows = table(`request:${method}`);
			equalRows(rows, schemaRows(contractJsonSchemas(method).input), `${method} request`);
			const schema = inputSchemas[method];
			if (!("shape" in schema)) throw new Error(`${method} must be an object schema`);
			// The object boundary above is checked; exported inputs erase the concrete ZodObject type.
			const shape = (schema as z.ZodObject).shape;
			for (const [field, value] of Object.entries(shape)) {
				expect(rows.find(row => row[0] === field)?.[2], `${method}.${field} optional`).toBe(value.isOptional() ? "no" : "yes");
			}
		});
		it(`${method}: response fields and complete schema-valid examples`, () => {
			const success = contractJsonSchemas(method).output.oneOf?.[0];
			if (!success || typeof success === "boolean") throw new Error(`Missing ${method} success schema`);
			equalRows(table(`response:${method}`), schemaRows(success), `${method} response`);
			expect(inputSchemas[method].safeParse(example(method, "request")).success, `${method} request example`).toBe(true);
			expect(outputSchemas[method].safeParse(example(method, "response")).success, `${method} response example`).toBe(true);
			equalRows(table(`errors:${method}`), Object.entries(MEMORY_ERROR_STATUS).map(([reason, status]) => [reason, String(status)]), `${method} errors`);
		});
	}
});
