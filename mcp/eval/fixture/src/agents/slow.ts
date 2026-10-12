'use agent';
import { fauxAssistantMessage, fauxText, fauxToolCall } from '@earendil-works/pi-ai';
import { useModel, useTool } from '@flue/runtime';
import * as v from 'valibot';
import { fauxModel, lastRole, lastText } from '../faux.ts';

// Waits for the number of milliseconds in the message (default 3000) in a
// tool, so callers can exercise pending replies, re-attaching, and abort.
const model = fauxModel('slow', (context) => {
	if (lastRole(context) === 'toolResult') {
		return fauxAssistantMessage(fauxText(`waited ${JSON.parse(lastText(context)).waited} ms`));
	}
	const ms = Number(lastText(context).match(/\d+/)?.[0] ?? 3000);
	return fauxAssistantMessage(fauxToolCall('wait', { ms }), { stopReason: 'toolUse' });
});

export function Slow() {
	useModel(model);
	useTool({
		name: 'wait',
		description: 'Wait for the given number of milliseconds (max 60000). Returns { waited }.',
		input: v.object({ ms: v.pipe(v.number(), v.minValue(0), v.maxValue(60_000)) }),
		async run({ data, signal }) {
			await new Promise<void>((resolve, reject) => {
				const timer = setTimeout(resolve, data.ms);
				signal?.addEventListener('abort', () => {
					clearTimeout(timer);
					reject(signal.reason);
				});
			});
			return { output: { waited: data.ms } };
		},
	});
	return 'Wait as long as the message asks with the wait tool, then say how long you waited.';
}
