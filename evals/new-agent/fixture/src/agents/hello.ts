'use agent';
import { useModel } from '@flue/runtime';

export function Hello() {
	useModel('anthropic/claude-haiku-4-5');
	return 'You are a helpful assistant. Keep replies short.';
}
