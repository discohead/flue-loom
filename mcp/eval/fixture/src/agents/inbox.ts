'use agent';
import { fauxAssistantMessage, fauxText } from '@earendil-works/pi-ai';
import { useModel } from '@flue/runtime';
import { fauxModel, lastText } from '../faux.ts';

// Acknowledges user messages and signals; signals arrive rendered as
// <signal type="…" key="value">body</signal>.
const model = fauxModel('inbox', (context) => {
	const text = lastText(context);
	const signal = text.match(/^<signal ([^>]*)>\n?([\s\S]*?)\n?<\/signal>$/);
	if (!signal) return fauxAssistantMessage(fauxText(`received message: ${text}`));
	const attributes = Object.fromEntries([...(signal[1] ?? '').matchAll(/([\w-]+)="([^"]*)"/g)].map((m) => [m[1], m[2]]));
	const { type = 'unknown', ...rest } = attributes;
	const extras = Object.entries(rest)
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([key, value]) => `${key}=${value}`)
		.join(', ');
	return fauxAssistantMessage(fauxText(`received signal ${type}${extras ? ` (${extras})` : ''}: ${signal[2]}`));
});

export function Inbox() {
	useModel(model);
	return 'Acknowledge every message and signal.';
}
