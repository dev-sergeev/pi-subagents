import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { lazyStream, type Api, type AssistantMessageEventStream, type Context, type Model, type SimpleStreamOptions } from "@earendil-works/pi-ai";

/** Stream through the host's registered provider after the caller resolves its model/auth options. */
export function streamRegistryModel(
	registry: ExtensionContext["modelRegistry"],
	model: Model<Api>,
	context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream {
	return lazyStream(model, async () => {
		options?.signal?.throwIfAborted();
		const provider = registry.getProvider(model.provider);
		if (!provider) throw new Error(`Model provider '${model.provider}' is not registered.`);
		return provider.streamSimple(model, context, options);
	});
}
