import type { LocaleResources } from "../_types";
import { defineLocaleResources } from "../locale-resource-helpers";
import { buildDateResolutionPrompt } from "../date-resolution-prompt";
import { buildDedupPrompt, buildExtractionPrompt } from "./extraction-prompts";
import { buildReflectionFallbackText, buildReflectionPrompt } from "./reflection-prompts";

const captureTriggers = {
	identityPattern:
		/\b(me llamo|mi nombre es|soy|vivo en|trabajo en|mi rol es|mi email es|mi teléfono es|alérgico a)\b/i,
	preferencePattern:
		/\b(yo|nosotros)\s+(prefiero|preferimos|amo|odio|quiero|necesito)\b|\b(me gusta|nos gusta|prefiero|preferencia|preferido)\b/i,
	entityPattern:
		/\+\d{10,}|[\w.-]+@[\w.-]+\.\w+|\b(proyecto|equipo|empresa|organización|gerente|esposa|esposo|hijo|hija|mascota|repo|servicio)\b/i,
	eventPattern:
		/\b(decidimos|decidió|eligió|cambió|migró|migrar|lanzó|publicó|incidente|pasó|desde ahora)\b/i,
	lessonPattern:
		/\b(aprendimos|lección|próxima vez|error|evitar|nunca más|causa raíz|la solución fue|sop)\b/i,
	explicitMemoryCommandPositivePatterns: [
		/^\s*(?:por\s+favor,?\s+)?(?:recuerda|recuérdate|recuerden|memoriza)\b/i,
		/^\s*(?:por\s+favor,?\s+)?(?:guarda|almacena|registra)\b[^\n]{0,200}\bcomo\s+(?:una\s+|la\s+)?memoria(?:\s+de\s+largo\s+plazo)?\b/i,
		/^\s*(?:por\s+favor,?\s+)?(?:guarda|almacena)\b[^\n]{0,200}\bpara\s+(?:más|mas)\s+tarde\b/i,
	],
	explicitMemoryCommandRecallQuestionPatterns: [
		/^\s*¿?\s*(?:te\s+acuerdas|recuerdas|recordáis|recordais)\b/i,
		/^\s*¿?\s*(?:puedes|sabes)\s+recordar\b/i,
	],
	explicitMemoryCommandManagementPatterns: [
		/^\s*(?:por\s+favor,?\s+)?(?:olvida|borra|elimina|quita|limpia|descarta)\b/i,
	],
	weekStartDay: 1,
} as const;

const noise = {
	denialPatterns: [
		/no tengo (ninguna )?(información|datos|memoria|registro)/i,
		/no estoy seguro (de|sobre)/i,
		/no recuerdo/i,
		/no me acuerdo/i,
		/parece que no tengo/i,
		/no pude encontrar/i,
		/no se encontraron memorias( relevantes)?/i,
		/no tengo acceso a/i,
	],
	metaQuestionPatterns: [
		/\b(recuerdas|te acuerdas|sabes (sobre|de))\b/i,
		/\bpuedes recordar\b/i,
		/\bte (dije|mencioné|comenté|conté)\b/i,
		/\bte he (dicho|mencionado|contado)\b/i,
		/\bqué (te dije|te conté|te mencioné)\b/i,
	],
	metaFrustrationPatterns: [
		/\b(nunca|jamás|no) (te acuerdas|recuerdas) (de )?(nada|lo que)\b/i,
		/\bpor qué (nunca|no|siempre) (te acuerdas|recuerdas|te olvidas|olvidas)\b/i,
		/\b(mi|la) memoria (está|no) (mal|vacía|rota|funciona|borrada)\b/i,
	],
} as const;



const toolDescriptions = {
	memoryRecall:
		"Busca en memorias a largo plazo usando recuperación híbrida (vector + búsqueda por palabras clave).",
	memoryStore: "Guarda información importante en la memoria a largo plazo.",
	memoryForget: "Elimina memorias específicas por ID o por consulta.",
	memoryUpdate: "Actualiza una memoria almacenada por ID.",
	memoryStats: "Muestra estadísticas de uso de memoria.",
	memoryList: "Lista las memorias almacenadas con paginación y filtros.",
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
	invariantSignals: [/\b(siempre|nunca|debe|regla|invariante|decisión|decision|estable)\b/i],
	derivedSignals: [
		/\b(aprendimos|observado|reflexión|reflexion|derivado|delta|verificar|cambio)\b/i,
	],
	openLoopSignals: [/\b(todo|seguimiento|siguiente|acción|accion|verificar|revisar)\b/i],
	invariantLegacySignals: [/\b(siempre|nunca|debe|regla|invariante|decisión|decision|estable)\b/i],
	derivedLegacySignals: [
		/\b(aprendimos|observado|reflexión|reflexion|derivado|delta|verificar|cambio)\b/i,
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
		correctionSignals: [/en realidad/i, /\bcorrección\b/i, /\bcorreccion\b/i],
		ackTokens: [/^(entendido|vale|ok|okay|bien)\s*[.!]?$/i],
		memoryIntent: [/recuerda|recordar|guarda/i],
		reflectionSliceClassifiers,
	},
);
