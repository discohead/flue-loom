'use agent';
import { fauxAssistantMessage, fauxText } from '@earendil-works/pi-ai';
import { useInitialData, useModel } from '@flue/runtime';
import * as v from 'valibot';
import { fauxModel } from '../faux.ts';

// Greets the member named in the conversation's creation data.
const model = fauxModel('profile', (context) => {
	const [, name = 'guest', plan = 'free'] = context.systemPrompt?.match(/member (.+) on the (\w+) plan/) ?? [];
	return fauxAssistantMessage(fauxText(`Hello ${name}, you are on the ${plan} plan.`));
});

const Member = v.object({ name: v.pipe(v.string(), v.minLength(1)), plan: v.picklist(['free', 'pro', 'team']) });

export function Profile() {
	useModel(model);
	const member = useInitialData<v.InferOutput<typeof Member>>();
	return `You assist member ${member?.name ?? 'guest'} on the ${member?.plan ?? 'free'} plan.`;
}

Profile.initialData = Member;
