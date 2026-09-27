import { Type, type FlueContext, type ToolDef } from '@flue/sdk/client';

export const triggers = { webhook: true };

const fetchDiff: ToolDef = {
	name: 'fetch_diff',
	description: 'Fetch the diff for a pull request',
	parameters: Type.Object({ pr: Type.Number() }),
	execute: async ({ pr }) => JSON.stringify({ pr, diff: '...' }),
};

export default async function ({ init, payload }: FlueContext<{ pr: number }>) {
	const agent = await init({ model: 'anthropic/claude-sonnet-4-6', tools: [fetchDiff], sandbox: 'empty' });
	const session = await agent.session();
	const review = await session.task(`Review pull request #${payload.pr}`, { role: 'reviewer' });
	return { review: review.text };
}
