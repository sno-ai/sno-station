import type { LocaleResources } from "../_types";
import { defineLocaleResources } from "../locale-resource-helpers";
import { buildDateResolutionPrompt } from "../date-resolution-prompt";
import { buildDedupPrompt, buildExtractionPrompt } from "./extraction-prompts";
import { buildReflectionFallbackText, buildReflectionPrompt } from "./reflection-prompts";

const captureTriggers = {
	identityPattern:
		/\b(ich heiße|ich heisse|heiße ich|heisse ich|mein name ist|ich bin|ich wohne|wohne in|ich arbeite|meine rolle ist|meine email ist|mein telefon ist|allergisch gegen)\b/i,
	preferencePattern:
		/\b(ich|wir)\s+(bevorzuge|mögen|mag|liebe|hasse|will|möchte|brauche)\b|\bbevorzuge\s+ich\b|\b(präferenz|bevorzugt)\b/i,
	entityPattern:
		/\+\d{10,}|[\w.-]+@[\w.-]+\.\w+|\b(projekt|team|firma|unternehmen|organisation|manager|ehefrau|ehemann|sohn|tochter|haustier|repo|dienst)\b/i,
	eventPattern:
		/\b(entschieden|beschlossen|gewählt|gewechselt|migriert|veröffentlicht|ausgerollt|vorfall|passiert|ab jetzt)\b/i,
	lessonPattern:
		/\b(gelernt|lektion|nächstes mal|fehler|vermeiden|nie wieder|ursache|lösung war|sop)\b/i,
	explicitMemoryCommandPositivePatterns: [
		/^\s*(?:bitte\s+)?(?:merke\s+dir|merk\s+dir|behalte)\b/i,
		/^\s*(?:bitte\s+)?(?:speichere|speicher)\b[^\n]{0,200}\b(?:als|im|in\s+der|in\s+dem)\s+(?:langzeit-?)?(?:erinnerung|gedächtnis|speicher)\b/i,
		/^\s*(?:bitte\s+)?speicher(?:e)?\b[^\n]{0,200}\bfür\s+später\b/i,
	],
	explicitMemoryCommandRecallQuestionPatterns: [
		/^\s*(?:weißt|weisst)\s+du\s+noch\b/i,
		/^\s*kannst\s+du\s+dich\s+\S{0,30}\s*erinnern\b/i,
		/^\s*erinnerst\s+du\s+dich\b/i,
	],
	explicitMemoryCommandManagementPatterns: [
		/^\s*(?:bitte\s+)?(?:vergiss|lösche|losche|entferne|leere|verwirf)\b/i,
	],
	weekStartDay: 1,
} as const;

const noise = {
	denialPatterns: [
		/ich habe (keine )?(informationen|daten|erinnerung|aufzeichnung)/i,
		/ich bin (mir )?nicht sicher/i,
		/ich erinnere mich nicht/i,
		/ich kann mich nicht erinnern/i,
		/es scheint, ich habe nicht/i,
		/ich konnte nichts finden/i,
		/keine (relevanten )?erinnerungen gefunden/i,
		/ich habe keinen zugriff auf/i,
	],
	metaQuestionPatterns: [
		/\b(erinnerst du dich|weißt du noch|kennst du)\b/i,
		/\bkannst du dich erinnern\b/i,
		/\bhabe ich (gesagt|erwähnt|geteilt)\b/i,
		/\bhabe ich dir (gesagt|erwähnt)\b/i,
		/\bwas habe ich (gesagt|erwähnt)\b/i,
	],
	metaFrustrationPatterns: [
		/\bdu (vergisst|merkst dir) (immer|nie|ständig|alles|nichts)\b/i,
		/\bwarum (vergisst|merkst) du (dir )?(immer|ständig|nie|alles|nichts)\b/i,
		/\b(dein|das) gedächtnis (ist|funktioniert) (kaputt|leer|weg|nicht|falsch)\b/i,
		/\bwarum (ist|sind) (mein|meine) (erinnerung|erinnerungen|gedächtnis) (weg|falsch|kaputt|leer)\b/i,
	],
} as const;



const toolDescriptions = {
	memoryRecall:
		"Durchsucht Langzeit-Erinnerungen mittels Precision-Recall-Abfrage (Vektor + Stichwortsuche).",
	memoryStore: "Speichert wichtige Informationen im Langzeitgedächtnis.",
	memoryForget: "Löscht bestimmte Erinnerungen anhand von ID oder Suchanfrage.",
	memoryUpdate: "Aktualisiert eine gespeicherte Erinnerung anhand der ID.",
	memoryStats: "Zeigt Statistiken zur Speichernutzung an.",
	memoryList: "Listet gespeicherte Erinnerungen mit Paginierung und Filtern auf.",
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
	invariantSignals: [/\b(immer|nie|muss|sollte|regel|invariante|entscheidung)\b/i],
	derivedSignals: [/\b(gelernt|beobachtet|reflexion|änderung|verifizieren|nächster lauf)\b/i],
	openLoopSignals: [/\b(todo|nachfassen|nächste|aktion|prüfen|verifizieren)\b/i],
	invariantLegacySignals: [/\b(immer|nie|muss|sollte|regel|invariante|entscheidung)\b/i],
	derivedLegacySignals: [/\b(gelernt|beobachtet|reflexion|änderung|verifizieren|nächster lauf)\b/i],
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
		correctionSignals: [/eigentlich/i, /\bkorrektur\b/i],
		ackTokens: [/^(verstanden|ok|okay|klar|gut)\s*[.!]?$/i],
		memoryIntent: [/merk dir|merken|erinnere/i],
		reflectionSliceClassifiers,
	},
);
