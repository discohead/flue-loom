import type { FlueContext } from '@flue/sdk/client';

export const triggers = { cron: '0 9 * * 1-5' };

export default async function ({ init }: FlueContext) {
	const agent = await init({ model: 'anthropic/claude-haiku-4-5' });
	const session = await agent.session();
	const digest = await session.prompt('Summarize yesterday\'s merged pull requests.');
	return { digest: digest.text };
}
