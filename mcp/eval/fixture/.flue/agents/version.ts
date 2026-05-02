import type { FlueContext } from '@flue/sdk/client';

export const triggers = { webhook: true };

export default async function (_ctx: FlueContext) {
	return {
		name: 'flue-loom-eval-fixture',
		version: '1.0.0',
		commit: 'a4b8c2d',
		buildDate: '2026-05-01',
	};
}
