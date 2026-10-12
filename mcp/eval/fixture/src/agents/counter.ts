'use agent';
import { fauxAssistantMessage, fauxText, fauxToolCall } from '@earendil-works/pi-ai';
import { useModel, usePersistentState, useTool } from '@flue/runtime';
import { fauxModel, lastRole, lastText } from '../faux.ts';

// Every message bumps a durable per-conversation counter, then reports it.
const model = fauxModel('counter', (context) =>
	lastRole(context) === 'toolResult'
		? fauxAssistantMessage(fauxText(`count: ${JSON.parse(lastText(context)).count}`))
		: fauxAssistantMessage(fauxToolCall('increment', {}), { stopReason: 'toolUse' }),
);

export function Counter() {
	useModel(model);
	const [count, setCount] = usePersistentState('count', 0);
	useTool({
		name: 'increment',
		description: 'Increment the conversation counter. Returns { count }.',
		async run() {
			setCount((previous) => previous + 1);
			return { output: { count: count + 1 } };
		},
	});
	return 'Call increment for every message, then report the count.';
}
