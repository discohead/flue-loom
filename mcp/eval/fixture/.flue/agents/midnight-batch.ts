import type { FlueContext } from '@flue/sdk/client';

export const triggers = { webhook: true, cron: '0 0 * * *' };

export default async function (_ctx: FlueContext) {
	return { kind: 'midnight', schedule: '0 0 * * *' };
}
