import type { StreamFn } from "@earendil-works/pi-agent-core";

export function agentStreamOptions(streamFn: StreamFn) {
	return { streamFunction: streamFn, streamFn };
}
