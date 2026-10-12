'use agent';
import { fauxAssistantMessage, fauxText, fauxToolCall } from '@earendil-works/pi-ai';
import { useDataWriter, useModel, useTool } from '@flue/runtime';
import * as v from 'valibot';
import { fauxModel, lastRole, lastText } from '../faux.ts';

// Calls `add` with the first two integers in the message, then reports the sum.
const model = fauxModel('calc', (context) => {
	if (lastRole(context) === 'toolResult') {
		return fauxAssistantMessage(fauxText(`The sum is ${JSON.parse(lastText(context)).sum}.`));
	}
	const [a = 0, b = 0] = (lastText(context).match(/-?\d+/g) ?? []).map(Number);
	return fauxAssistantMessage(fauxToolCall('add', { a, b }), { stopReason: 'toolUse' });
});

export function Calc() {
	useModel(model);
	const writeProgress = useDataWriter('progress', { schema: v.object({ step: v.string() }) });
	useTool({
		name: 'add',
		description: 'Add two numbers. Returns { sum }.',
		input: v.object({ a: v.number(), b: v.number() }),
		async run({ data }) {
			writeProgress({ step: `adding ${data.a} and ${data.b}` });
			return { output: { sum: data.a + data.b } };
		},
	});
	return 'Add the two numbers in the message with the add tool and report the sum.';
}
