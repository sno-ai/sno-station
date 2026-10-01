import {
	connect,
	type DegradedConnection,
	type MemoryClient,
} from "@snoai/memory/client";
import { SKIN_ID } from "./constants.js";

export async function connectMemory(): Promise<MemoryClient | DegradedConnection> {
	return connect({ skinId: SKIN_ID });
}

export function isDegradedConnection(
	connection: MemoryClient | DegradedConnection,
): connection is DegradedConnection {
	return connection.degraded;
}
