export function teachPrompt(fact: string): string {
	return `Please remember this project handoff detail for future sessions: ${fact}`;
}

export function recallPrompt(runId: string): string {
	return `For Project Prism ${runId}, what are my saved handoff code and status color? Answer with only the code and color for that project.`;
}

export function finalizePrompt(): string {
	return "The Agent 1:1 memory check is complete. Reply with exactly: done.";
}

export function noisePrompt(noiseNonce: string): string {
	return `n${noiseNonce.replace(/-/g, "").slice(0, 8)}`;
}

export function updateOldPrompt(
	updateSubject: string,
	updateOldNonce: string,
): string {
	return `For future context, my Project Prism ${updateSubject} launch code is ${updateOldNonce}. Reply with exactly: noted.`;
}

export function updateCorrectionPrompt(
	updateSubject: string,
	updateOldNonce: string,
	updateNewNonce: string,
): string {
	return `Correction for future context: my current Project Prism ${updateSubject} launch code is ${updateNewNonce}. The old value ${updateOldNonce} is no longer correct. Reply with exactly: noted.`;
}

export function updateRecallPrompt(updateSubject: string): string {
	return `What is the current Project Prism ${updateSubject} launch code? Answer with only the code.`;
}

export function consentMarker(kind: "on" | "off", nonce: string): string {
	return kind === "on"
		? `Project ConsentGuard ${nonce} uses release marker ${nonce} and owner Maya Chen.`
		: `Project ConsentGuard ${nonce} uses release marker ${nonce} and owner Priya Shah.`;
}

export function consentTeachPrompt(marker: string): string {
	return `Please remember this project handoff detail for future sessions: ${marker}`;
}

export function cjkTeachPrompt(fact: string): string {
	return `请记住这个中文使用偏好，之后我会问项目代号和茶饮偏好：${fact}`;
}

export function cjkRecallPrompt(): string {
	return "我的中文项目代号是什么？我的默认茶饮偏好是什么？只回答项目代号和茶名。";
}

export function multilingualTeachPrompt(fact: string): string {
	return `Para contexto futuro, mi dato persistente es: ${fact}. Responde solo: anotado.`;
}

export function multilingualRecallPrompt(marker: string): string {
	return `Para el proyecto ${marker}, cual es mi codigo de memoria en espanol y cual es mi ciudad favorita? Responde solo con el codigo y la ciudad.`;
}

export function similarMemoryTeachPrompt(
	marker: string,
	decoyCode: string,
	correctCode: string,
): string {
	return `Please remember these separate project handoff details for future sessions: For Project Atlas ${marker}, the blue notebook code is ${decoyCode}. For Project Atlas ${marker}, the blue backpack code is ${correctCode}. These are different items; later I will ask for the backpack code only. Reply with exactly: noted.`;
}

export function similarMemoryRecallPrompt(marker: string): string {
	return `For Project Atlas ${marker}, what is my blue backpack code? Answer with only that code.`;
}

export function exactCodeTeachPrompt(runId: string, code: string): string {
	return `For future context, Project Prism ${runId}'s exact support handoff identifier is ${code}. Its punctuation and letter case matter. Reply with exactly: noted.`;
}

export function exactCodeRecallPrompt(runId: string): string {
	return `For Project Prism ${runId}, what is my exact support handoff identifier? Answer with only the identifier, preserving punctuation and letter case.`;
}
