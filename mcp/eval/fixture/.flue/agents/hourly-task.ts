import type { FlueContext } from '@flue/sdk/client';

export const triggers = { webhook: true, cron: '0 * * * *' };

export default async function (_ctx: FlueContext) {
	return { kind: 'hourly', schedule: '0 * * * *' };
}
