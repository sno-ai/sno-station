import type { JsonValue } from "./types.js";

export function canonicalJson(value: JsonValue): string {
	if (value === null) {
		return "null";
	}
	if (typeof value === "string") {
		return JSON.stringify(value);
	}
	if (typeof value === "boolean") {
		return value ? "true" : "false";
	}
	if (typeof value === "number") {
		if (!Number.isFinite(value)) {
			throw new TypeError("canonical JSON cannot encode non-finite numbers");
		}
		if (Object.is(value, -0)) {
			return "0";
		}
		return JSON.stringify(value);
	}
	if (Array.isArray(value)) {
		return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
	}

	const keys = Object.keys(value).sort();
	const fields = keys.map((key) => {
		const fieldValue = value[key];
		if (fieldValue === undefined) {
			throw new TypeError("canonical JSON cannot encode undefined fields");
		}
		return `${JSON.stringify(key)}:${canonicalJson(fieldValue)}`;
	});
	return `{${fields.join(",")}}`;
}
