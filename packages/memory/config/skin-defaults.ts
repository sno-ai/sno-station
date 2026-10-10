export {
	DEFAULT_MODEL_MODE,
	PRODUCT_MODES,
	type ProductMode,
} from "./plugin-config-mode-schema";

export const HOST_MODEL_CALLBACK_HOST = "127.0.0.1";
export const HOST_MODEL_CALLBACK_PATH = "/v1/chat/completions";
/** Epoch milliseconds after which the requester no longer waits for the answer. */
export const HOST_MODEL_DEADLINE_HEADER = "x-sno-deadline";
