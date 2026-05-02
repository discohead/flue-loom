import type { FlueContext } from '@flue/sdk/client';

interface Payload {
	a: number;
	b: number;
}

export const triggers = { webhook: true };

export default async function ({ payload }: FlueContext<Payload>) {
	return { sum: payload.a + payload.b };
}
