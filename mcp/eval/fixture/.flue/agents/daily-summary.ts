import type { FlueContext } from '@flue/sdk/client';

export const triggers = { webhook: true, cron: '0 9 * * *' };

export default async function (_ctx: FlueContext) {
	return { kind: 'daily', schedule: '0 9 * * *' };
}
