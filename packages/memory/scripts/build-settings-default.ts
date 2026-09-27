import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defaultSettings } from "../config/settings";

writeFileSync(fileURLToPath(new URL("../settings.default.json", import.meta.url)),
	`${JSON.stringify(defaultSettings(), null, 2)}\n`);
