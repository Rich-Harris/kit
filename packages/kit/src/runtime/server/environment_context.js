/** @param {string} str */
function posixify(str) {
	return str.replace(/\\/g, '/');
}

/**
 * Prepend given path with `/@fs` prefix
 * @param {string} str
 */
export function to_fs(str) {
	str = posixify(str);
	return `/@fs${
		// Windows/Linux separation - Windows starts with a drive letter, we need a / in front there
		str.startsWith('/') ? '' : '/'
	}${str}`;
}

/**
 * Removes `/@fs` prefix from given path and posixifies it
 * @param {string} str
 */
export function from_fs(str) {
	str = posixify(str);
	if (!str.startsWith('/@fs')) return str;

	str = str.slice(4);
	// Windows/Linux separation - Windows starts with a drive letter, we need to strip the additional / here
	return str[2] === ':' && /[A-Z]/.test(str[1]) ? str.slice(1) : str;
}

/** @param {string} url */
async function loud_ssr_load_module(url) {
	// We can use a dynamic import rather than `vite.ssrLoadModule` because it will be executed inside the environment module runner.
	try {
		return await import(/* @vite-ignore */ url);
	} catch (/** @type {any} */ err) {
		import.meta.hot?.send('error', { ...err, message: err.message, stack: err.stack });
		throw err;
	}
}

/**
 * @param {string} cwd
 * @param {string} id
 */
function resolve(cwd, id) {
	const from = cwd.split(/[\\/]/);
	const to = id.split(/[\\/]/);

	while (to[0] === '..') {
		from.pop();
		to.shift();
	}

	return [...from, ...to].join('/');
}

/** @param {string} cwd */
export function create_resolve(cwd) {
	/** @param {string} id */
	return async function (id) {
		const url = id.startsWith('..') ? to_fs(resolve(cwd, id)) : `/${id}`;

		const module = await loud_ssr_load_module(url);

		return { module, url };

		// TODO: return module nodes or use alternative approach to collect dependencies for inlining CSS
	};
}
