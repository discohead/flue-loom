'use agent';
import { fauxAssistantMessage, fauxText } from '@earendil-works/pi-ai';
import { useModel } from '@flue/runtime';
import { fauxModel, lastText } from '../faux.ts';

const model = fauxModel('echo', (context) => fauxAssistantMessage(fauxText(`echo: ${lastText(context)}`)));

export function Echo() {
	useModel(model);
	return 'Repeat the user message back, prefixed with "echo: ".';
}
