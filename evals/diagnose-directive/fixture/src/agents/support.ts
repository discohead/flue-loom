import { defineTool, useModel, useTool } from '@flue/runtime';
import * as v from 'valibot';

'use agent';

const lookupOrder = defineTool({
	name: 'lookup_order',
	description: 'Look up an order by id. Returns its status.',
	input: v.object({ orderId: v.string() }),
	async run({ data }) {
		return { output: { orderId: data.orderId, status: 'shipped' } };
	},
});

export function Support() {
	useModel('anthropic/claude-sonnet-5');
	useTool(lookupOrder);
	return 'You answer questions about orders. Look orders up before answering.';
}
