import type { FlueContext } from '@flue/sdk/client';

export const triggers = { webhook: true };

export default async function ({ payload }: FlueContext<Record<string, unknown>>) {
	return { echoed: payload };
}
