// Deterministic stand-in models: each agent registers a faux provider whose
// responder is a pure function of the conversation, so replies are stable
// without API keys.
import { type Context, type FauxResponseFactory, fauxProvider } from '@earendil-works/pi-ai';
import { setProvider } from '@flue/runtime';

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

/** Text of the newest message (user text, a rendered signal, or a tool result). */
export function lastText(context: Context): string {
	const last = context.messages.at(-1);
	if (!last) return '';
	if (typeof last.content === 'string') return last.content;
	return last.content.map((block) => (block.type === 'text' ? block.text : '')).join('');
}

export function lastRole(context: Context): string | undefined {
	return context.messages.at(-1)?.role;
}
