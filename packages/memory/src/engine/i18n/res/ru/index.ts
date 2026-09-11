import type { LocaleResources } from "../_types";
import { defineLocaleResources } from "../locale-resource-helpers";
import { buildDateResolutionPrompt } from "../date-resolution-prompt";
import { buildDedupPrompt, buildExtractionPrompt } from "./extraction-prompts";
import { buildReflectionFallbackText, buildReflectionPrompt } from "./reflection-prompts";

const captureTriggers = {
	identityPattern:
		/(?:^|[^\p{L}\p{N}_])(меня зовут|моё имя|я живу|живу в|я работаю|моя роль|мой email|мой телефон|аллергия на)(?=$|[^\p{L}\p{N}_])/iu,
	preferencePattern:
		/(?:^|[^\p{L}\p{N}_])(?:(я|мы)\s+(предпочитаю|предпочитаем|люблю|любим|ненавижу|хочу|нужно)|(предпочитаю|предпочтение|любимый))(?=$|[^\p{L}\p{N}_])/iu,
	entityPattern:
		/\+\d{10,}|[\w.-]+@[\w.-]+\.\w+|(?:^|[^\p{L}\p{N}_])(проект|команда|компания|организация|менеджер|жена|муж|сын|дочь|питомец|репозиторий|сервис)(?=$|[^\p{L}\p{N}_])/iu,
	eventPattern:
		/(?:^|[^\p{L}\p{N}_])(решили|выбрали|перешли|мигрировали|выпустили|развернули|инцидент|случилось|теперь)(?=$|[^\p{L}\p{N}_])/iu,
	lessonPattern:
		/(?:^|[^\p{L}\p{N}_])(урок|выучили|в следующий раз|ошибка|избегать|никогда снова|корневая причина|решением было|sop)(?=$|[^\p{L}\p{N}_])/iu,
	explicitMemoryCommandPositivePatterns: [
		/^\s*(?:пожалуйста,?\s+)?(?:запомни|запомните)(?=$|[^\p{L}\p{N}_])/iu,
		/^\s*(?:сохрани|сохраните)(?=$|[^\p{L}\p{N}_])[^\n]{0,200}(?:^|[^\p{L}\p{N}_])как\s+(?:долговременную\s+)?память(?=$|[^\p{L}\p{N}_])/iu,
		/^\s*(?:сохрани|сохраните)(?=$|[^\p{L}\p{N}_])[^\n]{0,200}(?:^|[^\p{L}\p{N}_])на\s+(?:будущее|потом)(?=$|[^\p{L}\p{N}_])/iu,
	],
	explicitMemoryCommandRecallQuestionPatterns: [
		/^\s*(?:помнишь|помните)(?=$|[^\p{L}\p{N}_])/iu,
		/^\s*(?:ты|вы)\s+(?:всё\s+ещё\s+)?(?:помнишь|помните)(?=$|[^\p{L}\p{N}_])/iu,
	],
	explicitMemoryCommandManagementPatterns: [
		/^\s*(?:пожалуйста,?\s+)?(?:забудь|забудьте|удали|удалите|очисти|очистите|сотри|сотрите|убери|уберите)(?=$|[^\p{L}\p{N}_])/iu,
	],
	weekStartDay: 1,
} as const;

const noise = {
	denialPatterns: [
		/у меня нет (никакой )?(информации|данных|памяти|записи)/i,
		/я не уверен/i,
		/я не помню/i,
		/я не припоминаю/i,
		/похоже у меня нет/i,
		/я не смог найти/i,
		/(релевантные )?воспоминания не найдены/i,
		/у меня нет доступа к/i,
	],
	metaQuestionPatterns: [
		/(?:^|[^\p{L}\p{N}_])(помнишь|ты помнишь|вспоминаешь|знаешь о)(?=$|[^\p{L}\p{N}_])/iu,
		/(?:^|[^\p{L}\p{N}_])можешь (вспомнить|припомнить)(?=$|[^\p{L}\p{N}_])/iu,
		/(?:^|[^\p{L}\p{N}_])я (тебе )?(говорил[ао]?|упоминал[ао]?|сказал[ао]?|поделил[ао]?сь)(?=$|[^\p{L}\p{N}_])/iu,
		/(?:^|[^\p{L}\p{N}_])я (уже )?(говорил[ао]?|упоминал[ао]?)(?=$|[^\p{L}\p{N}_])/iu,
		/(?:^|[^\p{L}\p{N}_])что я (тебе )?(сказал[ао]?|говорил[ао]?|упоминал[ао]?)(?=$|[^\p{L}\p{N}_])/iu,
	],
	metaFrustrationPatterns: [
		/(?:^|[^\p{L}\p{N}_])ты (никогда не|вечно|опять|постоянно|снова) (помнишь|запоминаешь|забываешь|забыл[аи]?|теряешь|потерял[аи]?)(?=$|[^\p{L}\p{N}_])/iu,
		/(?:^|[^\p{L}\p{N}_])почему ты (не помнишь|опять забыл|вечно забываешь|ничего не помнишь)(?=$|[^\p{L}\p{N}_])/iu,
		/(?:^|[^\p{L}\p{N}_])(моя |твоя )?память (не работает|пустая|сломана|стерлась|пропала)(?=$|[^\p{L}\p{N}_])/iu,
	],
} as const;



const toolDescriptions = {
	memoryRecall:
		"Поиск в долговременной памяти с помощью гибридного извлечения (вектор + поиск по ключевым словам).",
	memoryStore: "Сохраняет важную информацию в долговременной памяти.",
	memoryForget: "Удаляет определённые воспоминания по ID или запросу.",
	memoryUpdate: "Обновляет сохранённое воспоминание по ID.",
	memoryStats: "Показывает статистику использования памяти.",
	memoryList: "Показывает список сохранённых воспоминаний с пагинацией и фильтрами.",
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
	invariantSignals: [
		/(?:^|[^\p{L}\p{N}_])(всегда|никогда|должен|правило|инвариант|решение)(?=$|[^\p{L}\p{N}_])/iu,
	],
	derivedSignals: [
		/(?:^|[^\p{L}\p{N}_])(узнали|наблюдали|рефлексия|вывод|дельта|проверить|изменение)(?=$|[^\p{L}\p{N}_])/iu,
	],
	openLoopSignals: [
		/(?:^|[^\p{L}\p{N}_])(todo|следующее|действие|проверить|перепроверить)(?=$|[^\p{L}\p{N}_])/iu,
	],
	invariantLegacySignals: [
		/(?:^|[^\p{L}\p{N}_])(всегда|никогда|должен|правило|инвариант|решение)(?=$|[^\p{L}\p{N}_])/iu,
	],
	derivedLegacySignals: [
		/(?:^|[^\p{L}\p{N}_])(узнали|наблюдали|рефлексия|вывод|дельта|проверить|изменение)(?=$|[^\p{L}\p{N}_])/iu,
	],
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
		correctionSignals: [
			/(?:^|[^\p{L}\p{N}_])(на самом деле|исправление|не так)(?=$|[^\p{L}\p{N}_])/iu,
		],
		ackTokens: [/^\s*(понял|поняла|понятно|хорошо|окей)\s*[.!]?$/iu],
		memoryIntent: [/(?:^|[^\p{L}\p{N}_])(запомни|помни|сохрани)(?=$|[^\p{L}\p{N}_])/iu],
		reflectionSliceClassifiers,
	},
);
