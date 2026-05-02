// Minimal SSE parser. Reads a Response body stream, yields { event, data } pairs.

import { HttpError } from './http.ts';

export interface SseEvent {
	event: string;
	data: string;
}

export async function* parseSse(body: ReadableStream<Uint8Array>): AsyncIterable<SseEvent> {
	const decoder = new TextDecoder();
	const reader = body.getReader();
	let buffer = '';

	let event = '';
	let dataLines: string[] = [];

	const flush = (): SseEvent | undefined => {
		if (event === '' && dataLines.length === 0) return undefined;
		const e = { event: event || 'message', data: dataLines.join('\n') };
		event = '';
		dataLines = [];
		return e;
	};

	while (true) {
		const { value, done } = await reader.read();
		if (done) break;
		buffer += decoder.decode(value, { stream: true });

		let nl: number;
		while ((nl = buffer.indexOf('\n')) !== -1) {
			const line = buffer.slice(0, nl).replace(/\r$/, '');
			buffer = buffer.slice(nl + 1);

			if (line === '') {
				const e = flush();
				if (e) yield e;
				continue;
			}
			if (line.startsWith(':')) continue; // comment

			const colon = line.indexOf(':');
			const field = colon === -1 ? line : line.slice(0, colon);
			const rawValue = colon === -1 ? '' : line.slice(colon + 1);
			const value = rawValue.startsWith(' ') ? rawValue.slice(1) : rawValue;

			if (field === 'event') {
				event = value;
			} else if (field === 'data') {
				dataLines.push(value);
			}
			// Other fields (id, retry) ignored.
		}
	}

	const trailing = flush();
	if (trailing) yield trailing;
}

export interface PostSseOptions {
	headers?: Record<string, string>;
	signal?: AbortSignal;
}

export async function postSse(
	url: string,
	body: unknown,
	options: PostSseOptions = {},
): Promise<ReadableStream<Uint8Array>> {
	const res = await fetch(url, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			Accept: 'text/event-stream',
			...options.headers,
		},
		body: JSON.stringify(body ?? {}),
		signal: options.signal,
	});
	if (!res.ok) {
		const text = await res.text().catch(() => res.statusText);
		let parsed: unknown = text;
		try {
			parsed = JSON.parse(text);
		} catch {
			/* keep as text */
		}
		throw new HttpError(res.status, res.statusText, parsed, url);
	}
	if (!res.body) throw new Error('SSE response has no body');
	return res.body;
}
