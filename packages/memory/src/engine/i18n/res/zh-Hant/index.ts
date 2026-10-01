import type { LocaleResources } from "../_types";
import { defineLocaleResources } from "../locale-resource-helpers";
import { buildDateResolutionPrompt } from "../date-resolution-prompt";
import { buildDedupPrompt, buildExtractionPrompt } from "./extraction-prompts";
import { buildReflectionFallbackText, buildReflectionPrompt } from "./reflection-prompts";

const captureTriggers = {
	identityPattern: /我的.+是|我叫|名字|住在|工作於|過敏|信箱|電話/,
	preferencePattern: /喜歡|偏好|討厭|不喜歡|愛用|習慣|想要|需要/,
	entityPattern: /\+\d{10,}|[\w.-]+@[\w.-]+\.\w+|專案|團隊|公司|組織|經理|寵物|服務|倉庫|聯絡人/,
	eventPattern: /決定|選擇|改用|上線|發布|部署|事故|發生|以後|從現在開始/,
	lessonPattern: /學到|教訓|經驗教訓|下次|避免|根因|復盤|反思|錯誤|解決方案/,
	explicitMemoryCommandPositivePatterns: [
		/^\s*(?:請|麻煩|幫我)?\s*(?:記住|記一下|記下|幫記|幫記住)/,
		/^\s*(?:請)?\s*(?:把|將)[^\n]{0,80}(?:保存|存)(?:為|到|進|作為)[^\n]{0,30}(?:長期)?記憶/,
		/^\s*(?:請)?\s*(?:把|將)[^\n]{0,80}(?:保存|存)[^\n]{0,30}(?:以備|供|留作)[^\n]{0,20}(?:日後|以後|後續)(?:回憶|參考|查閱)/,
	],
	explicitMemoryCommandRecallQuestionPatterns: [
		/^\s*(?:你)?(?:還)?\s*記得[^\n]{0,40}嗎\??/,
		/^\s*你能(?:想起|回憶起|記起)[^\n]{0,40}嗎\??/,
	],
	explicitMemoryCommandManagementPatterns: [
		/^\s*(?:請|麻煩)?\s*(?:忘記|忘掉|刪除|刪掉|清除|清空|擦除|清掉|抹去)/,
	],
	weekStartDay: 1,
} as const;

const noise = {
	denialPatterns: [
		/我沒有(任何)?(資訊|資料|記憶|記錄)/,
		/我不太確定/,
		/我不記得/,
		/我想不起來/,
		/看起來我沒有/,
		/我沒找到/,
		/沒有找到(相關)?記憶/,
		/我沒有存取權限/,
	],
	metaQuestionPatterns: [
		/[你妳]還?記得/,
		/記不記得/,
		/還記得.*嗎/,
		/[你妳]知道.+嗎/,
		/我(?:之前|上次|以前)(?:說|提|講).*(?:嗎|呢|？|\?)/,
		/我(?:之前|以前|上次|先前|曾經).{0,30}(保存|存|記住|記下|記錄|記憶).{0,40}(是什麼|什麼|哪|嗎|呢|？|\?)/,
		/(我的|我).{0,30}(保存|存|記住|記下|記錄|記憶).{0,40}(是什麼|什麼|哪|嗎|呢|？|\?)/,
		/如果[你妳]知道.+只回覆/,
		/如果不知道.+只回覆\s*none/,
		/只回答.{0,30}(驗證碼|代號|代碼|名稱|名字|茶名)/,
		/只回覆精確代號/,
		/只回覆\s*none/,
	],
	metaFrustrationPatterns: [
		/[你妳](從來|老是|總是|怎麼|又|還|經常){0,3}(記不住|不記得|記不得|忘記|忘了)/,
		/為什麼[你妳](總是|老是|又|還|從來|經常){0,3}(不記得|記不住|忘)/,
		/我的(記憶|記錄|筆記)(怎麼|為什麼)?(沒了|不見了|是錯的|壞了|亂了|不對|丟了)/,
	],
} as const;



const toolDescriptions = {
	memoryRecall: "透過混合檢索（向量 + 關鍵字）搜尋長期記憶。",
	memoryStore: "將重要資訊儲存到長期記憶中。",
	memoryForget: "依 ID 或查詢刪除指定的記憶。",
	memoryUpdate: "依 ID 更新已儲存的記憶。",
	memoryStats: "顯示記憶使用統計。",
	memoryList: "列出已儲存的記憶，支援分頁與篩選。",
} as const;

const extractionPrompts = {
	buildDateResolutionPrompt,
	buildExtractionPrompt,
	buildDedupPrompt,
} as const;

const reflectionPrompts = {
	buildReflectionPrompt,
	buildReflectionFallbackText,
} as const;

const reflectionSliceClassifiers = {
	invariantSignals: [/總是|從不|必須|應該|規則|不變|決定|穩定/],
	derivedSignals: [/學到|觀察|反思|派生|變化|驗證|複查/],
	openLoopSignals: [/待辦|跟進|下一步|行動|驗證|複查/],
	invariantLegacySignals: [/總是|從不|必須|應該|規則|不變|決定|穩定/],
	derivedLegacySignals: [/學到|觀察|反思|派生|變化|驗證|複查/],
} as const;

export const resources: LocaleResources = defineLocaleResources(
	{
		captureTriggers,
		noise,
		toolDescriptions,
		extractionPrompts,
		reflectionPrompts,
	},
	{
		correctionSignals: [/其實|不對|錯了|更正|應該是|改成/],
		ackTokens: [/^(了解|好的|好|嗯|收到|明白|知道了|👍)\s*[。.!]?$/],
		memoryIntent: [/記住|記一下|保存|別忘了/],
		reflectionSliceClassifiers,
	},
);
