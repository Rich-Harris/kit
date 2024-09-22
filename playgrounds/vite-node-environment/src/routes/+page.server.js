'use ssr';

import { read } from '$app/server';
import favicon from '../../static/favicon.png';

function getUserAgentText() {
	if (typeof navigator === 'undefined') {
		return 'navigator is undefined (running in Node.js?)';
	}

	return `navigator.userAgent = ${navigator.userAgent}`;
}

export function load() {
	const asset = read(favicon);

	return { userAgentText: getUserAgentText() };
}
