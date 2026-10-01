/** Compile-contract RED for ACC-12: only model responses vary across five named stages. */

import {
	createRemModelStageResponsePort,
	REM_MODEL_STAGES,
	runRemBatchJob,
} from "../../../../packages/memory/src/sidecar/rem-batch-executor.ts";

const expectedStages = [
	"rem-replace-clause-carry",
	"rem-update-judgment",
	"rem-update-verification",
	"rem-update-relation-judgment",
	"rem-update-relation",
	"rem-update-selection",
	"rem-replace-pair",
	"rem-replace-clauses",
	"rem-replace-coverage",
] as const;

const exactStages: typeof expectedStages = REM_MODEL_STAGES;
const stageResponses = createRemModelStageResponsePort({
	respond: async (request: { stage: (typeof expectedStages)[number]; prompt: string }) => {
		void request.prompt;
		return request.stage === "rem-replace-coverage" ? "{invalid" : "{}";
	},
});

void runRemBatchJob({
	jobId: "job-five-stage-contract",
	jobType: "rem-replace",
	scope: "persona:five-stage-contract",
	modelStageResponses: stageResponses,
});

void exactStages;
