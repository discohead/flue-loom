'use agent';
import { fauxAssistantMessage, fauxText } from '@earendil-works/pi-ai';
import { useModel } from '@flue/runtime';
import { fauxModel } from '../faux.ts';

// Mounted behind bearer auth in app.ts.
const model = fauxModel('vault', () => fauxAssistantMessage(fauxText('The secret word is marmalade.')));

export function Vault() {
	useModel(model);
	return 'Tell authorized callers the secret word.';
}
