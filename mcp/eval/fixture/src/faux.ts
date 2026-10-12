// Deterministic stand-in models: each agent registers a faux provider whose
// responder is a pure function of the conversation, so replies are stable
// without API keys.
import { type FauxResponseFactory, fauxProvider } from '@earendil-works/pi-ai';
import { setProvider } from '@flue/runtime';

/** The transcript a faux responder receives (Pi 1.x: system prompt included as `system` messages). */
type Transcript = Parameters<FauxResponseFactory>[0];
type TranscriptMessage = Transcript['messages'][number];

/** Register `<name>/model` and answer every model call with `respond`. */
export function fauxModel(name: string, respond: FauxResponseFactory): string {
	const faux = fauxProvider({ api: `fixture-${name}`, provider: name, models: [{ id: 'model' }] });
	setProvider(faux.provider);
	const loop: FauxResponseFactory = (...args) => {
		faux.appendResponses([loop]);
		return respond(...args);
	};
	faux.setResponses([loop]);
	return `${name}/model`;
}

function textOf(message: TranscriptMessage): string {
	if (typeof message.content === 'string') return message.content;
	return message.content.map((block) => (block.type === 'text' ? block.text : '')).join('');
}

/** The newest conversation message — user text, a rendered signal, or a tool result. */
function lastMessage(context: Transcript): TranscriptMessage | undefined {
	return context.messages.findLast((message) => message.role !== 'system');
}

export function lastText(context: Transcript): string {
	const last = lastMessage(context);
	return last ? textOf(last) : '';
}

export function lastRole(context: Transcript): string | undefined {
	return lastMessage(context)?.role;
}

/** The agent's instructions: every system message's text and prompt sections, in order. */
export function systemText(context: Transcript): string {
	return context.messages
		.flatMap((message) =>
			message.role === 'system'
				? [textOf(message), ...Object.values(message.sections ?? {}).filter((section): section is string => typeof section === 'string')]
				: [],
		)
		.join('\n');
}
