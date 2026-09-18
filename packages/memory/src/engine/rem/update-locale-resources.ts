export const REM_UPDATE_LOCALES = [
	"en",
	"de",
	"es",
	"fr",
	"zh",
	"zh-Hant",
	"ja",
	"ko",
	"ru",
] as const;

export type RemUpdateLocale = (typeof REM_UPDATE_LOCALES)[number];

export interface RemUpdateLocaleResource {
	valuePrefix: string;
	listPrefix: string;
	listSeparator: string;
	spanSeparator: string;
	anchorMode: "capitalized-sequence" | "explicit-script";
}

const REM_UPDATE_LOCALE_RESOURCES = {
	en: {
		valuePrefix: "Current preference: ",
		listPrefix: "Current todos: ",
		listSeparator: ", ",
		spanSeparator: " ",
		anchorMode: "capitalized-sequence",
	},
	de: {
		valuePrefix: "Aktuelle Präferenz: ",
		listPrefix: "Aktuelle Aufgaben: ",
		listSeparator: ", ",
		spanSeparator: " ",
		anchorMode: "capitalized-sequence",
	},
	es: {
		valuePrefix: "Preferencia actual: ",
		listPrefix: "Tareas actuales: ",
		listSeparator: ", ",
		spanSeparator: " ",
		anchorMode: "capitalized-sequence",
	},
	fr: {
		valuePrefix: "Préférence actuelle : ",
		listPrefix: "Tâches actuelles : ",
		listSeparator: ", ",
		spanSeparator: " ",
		anchorMode: "capitalized-sequence",
	},
	zh: {
		valuePrefix: "当前偏好：",
		listPrefix: "当前任务：",
		listSeparator: "、",
		spanSeparator: "",
		anchorMode: "explicit-script",
	},
	"zh-Hant": {
		valuePrefix: "目前偏好：",
		listPrefix: "目前任務：",
		listSeparator: "、",
		spanSeparator: "",
		anchorMode: "explicit-script",
	},
	ja: {
		valuePrefix: "現在の好み：",
		listPrefix: "現在のタスク：",
		listSeparator: "、",
		spanSeparator: "",
		anchorMode: "explicit-script",
	},
	ko: {
		valuePrefix: "현재 선호: ",
		listPrefix: "현재 작업: ",
		listSeparator: ", ",
		spanSeparator: " ",
		anchorMode: "explicit-script",
	},
	ru: {
		valuePrefix: "Текущее предпочтение: ",
		listPrefix: "Текущие задачи: ",
		listSeparator: ", ",
		spanSeparator: " ",
		anchorMode: "capitalized-sequence",
	},
} as const satisfies Record<RemUpdateLocale, RemUpdateLocaleResource>;

export function getRemUpdateLocaleResource(locale: RemUpdateLocale): RemUpdateLocaleResource {
	return REM_UPDATE_LOCALE_RESOURCES[locale];
}
