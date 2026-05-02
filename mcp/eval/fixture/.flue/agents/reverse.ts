import type { FlueContext } from '@flue/sdk/client';

interface Payload {
	s: string;
}

export const triggers = { webhook: true };

export default async function ({ payload }: FlueContext<Payload>) {
	const reversed = (payload.s ?? '').split('').reverse().join('');
	return { reversed };
}
