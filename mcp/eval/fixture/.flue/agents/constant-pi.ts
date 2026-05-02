import type { FlueContext } from '@flue/sdk/client';

export const triggers = { webhook: true };

export default async function (_ctx: FlueContext) {
	return { value: '3.14159265358979' };
}
