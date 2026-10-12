'use agent';
import { fauxAssistantMessage } from '@earendil-works/pi-ai';
import { useModel } from '@flue/runtime';
import { fauxModel } from '../faux.ts';

// Its model always fails, so every submission settles as failed.
const model = fauxModel('broken', () => fauxAssistantMessage([], { stopReason: 'error', errorMessage: 'upstream model unavailable' }));

export function Broken() {
	useModel(model);
	return 'This agent cannot answer.';
}

Broken.durability = { maxAttempts: 1 };
