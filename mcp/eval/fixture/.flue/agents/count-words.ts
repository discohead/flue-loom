import type { FlueContext } from '@flue/sdk/client';

interface Payload {
	text: string;
}

export const triggers = { webhook: true };

export default async function ({ payload }: FlueContext<Payload>) {
	const tokens = (payload.text ?? '').split(/\s+/).filter(Boolean);
	return { count: tokens.length, text: payload.text };
}
