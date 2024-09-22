import fs from 'node:fs';
import path from 'node:path';
import { URL } from 'node:url';
import { AsyncLocalStorage } from 'node:async_hooks';
import colors from 'kleur';
import sirv from 'sirv';
import { getRequest, setResponse } from '../../../exports/node/index.js';
import { installPolyfills } from '../../../exports/node/polyfills.js';
import { coalesce_to_error } from '../../../utils/error.js';
import { posixify, resolve_entry, to_fs } from '../../../utils/filesystem.js';
import { load_error_page } from '../../../core/config/index.js';
import { SVELTE_KIT_ASSETS } from '../../../constants.js';
import * as sync from '../../../core/sync/sync.js';
import { runtime_base } from '../../../core/utils.js';
import { not_found } from '../utils.js';
import { SCHEME } from '../../../utils/url.js';
import { check_feature } from '../../../utils/features.js';
import { sveltekit_environment_context } from '../module_ids.js';

/**
 * @param {import('vite').ViteDevServer} vite
 * @param {import('vite').ResolvedConfig} vite_config
 * @param {import('types').ValidatedConfig} svelte_config
 * @return {Promise<Promise<() => void>>}
 */
export async function dev(vite, vite_config, svelte_config) {
	installPolyfills();

	const async_local_storage = new AsyncLocalStorage();

	globalThis.__SVELTEKIT_TRACK__ = (label) => {
		const context = async_local_storage.getStore();
		if (!context || context.prerender === true) return;

		check_feature(context.event.route.id, context.config, label, svelte_config.kit.adapter);
	};

	const fetch = globalThis.fetch;
	globalThis.fetch = (info, init) => {
		if (typeof info === 'string' && !SCHEME.test(info)) {
			throw new Error(
				`Cannot use relative URL (${info}) with global fetch — use \`event.fetch\` instead: https://kit.svelte.dev/docs/web-standards#fetch-apis`
			);
		}

		return fetch(info, init);
	};

	sync.init(svelte_config, vite_config.mode);

	/** @type {import('types').ManifestData} */
	let manifest_data;

	/** @type {Error | null} */
	let manifest_error = null;

	function update_manifest() {
		try {
			({ manifest_data } = sync.create(svelte_config));

			// Invalidate the virtual module.
			for (const environment in vite.environments) {
				const module = vite.environments[environment].moduleGraph.getModuleById(
					sveltekit_environment_context
				);

				if (module) {
					vite.environments[environment].moduleGraph.invalidateModule(module);
				}
			}

			if (manifest_error) {
				manifest_error = null;
				vite.ws.send({ type: 'full-reload' });
			}
		} catch (error) {
			manifest_error = /** @type {Error} */ (error);

			console.error(colors.bold().red(manifest_error.message));
			vite.ws.send({
				type: 'error',
				err: {
					message: manifest_error.message ?? 'Invalid routes',
					stack: ''
				}
			});

			return;
		}
	}

	/** @param {Error} error */
	function fix_stack_trace(error) {
		vite.ssrFixStacktrace(error);
		return error.stack;
	}

	update_manifest();

	/**
	 * @param {string} event
	 * @param {(file: string) => void} cb
	 */
	const watch = (event, cb) => {
		vite.watcher.on(event, (file) => {
			if (
				file.startsWith(svelte_config.kit.files.routes + path.sep) ||
				file.startsWith(svelte_config.kit.files.params + path.sep) ||
				// in contrast to server hooks, client hooks are written to the client manifest
				// and therefore need rebuilding when they are added/removed
				file.startsWith(svelte_config.kit.files.hooks.client)
			) {
				cb(file);
			}
		});
	};
	/** @type {NodeJS.Timeout | null } */
	let timeout = null;
	/** @param {() => void} to_run */
	const debounce = (to_run) => {
		timeout && clearTimeout(timeout);
		timeout = setTimeout(() => {
			timeout = null;
			to_run();
		}, 100);
	};

	// flag to skip watchers if server is already restarting
	let restarting = false;

	// Debounce add/unlink events because in case of folder deletion or moves
	// they fire in rapid succession, causing needless invocations.
	watch('add', () => debounce(update_manifest));
	watch('unlink', () => debounce(update_manifest));
	watch('change', (file) => {
		// Don't run for a single file if the whole manifest is about to get updated
		if (timeout || restarting) return;

		sync.update(svelte_config, manifest_data, file);
	});

	const { appTemplate, errorTemplate, serviceWorker, hooks } = svelte_config.kit.files;

	// vite client only executes a full reload if the triggering html file path is index.html
	// kit defaults to src/app.html, so unless user changed that to index.html
	// send the vite client a full-reload event without path being set
	if (appTemplate !== 'index.html') {
		vite.watcher.on('change', (file) => {
			if (file === appTemplate && !restarting) {
				vite.ws.send({ type: 'full-reload' });
			}
		});
	}

	vite.watcher.on('all', (_, file) => {
		if (
			file === appTemplate ||
			file === errorTemplate ||
			file.startsWith(serviceWorker) ||
			file.startsWith(hooks.server)
		) {
			sync.server(svelte_config);
		}
	});

	// changing the svelte config requires restarting the dev server
	// the config is only read on start and passed on to vite-plugin-svelte
	// which needs up-to-date values to operate correctly
	vite.watcher.on('change', (file) => {
		if (path.basename(file) === 'svelte.config.js') {
			console.log(`svelte config changed, restarting vite dev-server. changed file: ${file}`);
			restarting = true;
			vite.restart();
		}
	});

	const assets = svelte_config.kit.paths.assets ? SVELTE_KIT_ASSETS : svelte_config.kit.paths.base;
	const asset_server = sirv(svelte_config.kit.files.assets, {
		dev: true,
		etag: true,
		maxAge: 0,
		extensions: [],
		setHeaders: (res) => {
			res.setHeader('access-control-allow-origin', '*');
		}
	});

	async function align_exports() {
		// This shameful hack allows us to load runtime server code via Vite
		// while apps load `HttpError` and `Redirect` in Node, without
		// causing `instanceof` checks to fail
		const control_module_node = await import('../../../runtime/control.js');
		const control_module_vite = await vite.ssrLoadModule(`${runtime_base}/control.js`);

		control_module_node.replace_implementations({
			ActionFailure: control_module_vite.ActionFailure,
			HttpError: control_module_vite.HttpError,
			Redirect: control_module_vite.Redirect,
			SvelteKitError: control_module_vite.SvelteKitError
		});
	}
	align_exports();
	const ws_send = vite.ws.send;
	/** @param {any} args */
	vite.ws.send = function (...args) {
		// We need to reapply the patch after Vite did dependency optimizations
		// because that clears the module resolutions
		if (args[0]?.type === 'full-reload' && args[0].path === '*') {
			align_exports();
		}
		return ws_send.apply(vite.ws, args);
	};

	vite.middlewares.use((req, res, next) => {
		try {
			const base = `${vite.config.server.https ? 'https' : 'http'}://${
				req.headers[':authority'] || req.headers.host
			}`;

			const decoded = decodeURI(new URL(base + req.url).pathname);

			if (decoded.startsWith(assets)) {
				const pathname = decoded.slice(assets.length);
				const file = svelte_config.kit.files.assets + pathname;

				if (fs.existsSync(file) && !fs.statSync(file).isDirectory()) {
					if (has_correct_case(file, svelte_config.kit.files.assets)) {
						req.url = encodeURI(pathname); // don't need query/hash
						asset_server(req, res);
						return;
					}
				}
			}

			next();
		} catch (e) {
			const error = coalesce_to_error(e);
			res.statusCode = 500;
			res.end(fix_stack_trace(error));
		}
	});

	const dev_env =
		/** @type {import('vite').DevEnvironment & { dispatchFetch: (request: Request) => Promise<Response> }} */ (
			vite.environments.ssr
		);

	dev_env.hot.on('error', (err) => {
		vite.environments.client.hot.send({
			type: 'error',
			err
		});
	});

	return () => {
		const serve_static_middleware = vite.middlewares.stack.find(
			(middleware) =>
				/** @type {function} */ (middleware.handle).name === 'viteServeStaticMiddleware'
		);

		// Vite will give a 403 on URLs like /test, /static, and /package.json preventing us from
		// serving routes with those names. See https://github.com/vitejs/vite/issues/7363
		remove_static_middlewares(vite.middlewares);

		vite.middlewares.use(async (req, res) => {
			// Vite's base middleware strips out the base path. Restore it
			const original_url = req.url;
			req.url = req.originalUrl;
			try {
				const base = `${vite.config.server.https ? 'https' : 'http'}://${
					req.headers[':authority'] || req.headers.host
				}`;

				const decoded = decodeURI(new URL(base + req.url).pathname);
				const file = posixify(path.resolve(decoded.slice(svelte_config.kit.paths.base.length + 1)));
				const is_file = fs.existsSync(file) && !fs.statSync(file).isDirectory();
				const allowed =
					!vite_config.server.fs.strict ||
					vite_config.server.fs.allow.some((dir) => file.startsWith(dir));

				if (is_file && allowed) {
					req.url = original_url;
					// @ts-expect-error
					serve_static_middleware.handle(req, res);
					return;
				}

				if (!decoded.startsWith(svelte_config.kit.paths.base)) {
					return not_found(req, res, svelte_config.kit.paths.base);
				}

				if (decoded === svelte_config.kit.paths.base + '/service-worker.js') {
					const resolved = resolve_entry(svelte_config.kit.files.serviceWorker);

					if (resolved) {
						res.writeHead(200, {
							'content-type': 'application/javascript'
						});
						res.end(`import '${to_fs(resolved)}';`);
					} else {
						res.writeHead(404);
						res.end('not found');
					}

					return;
				}

				const request = await getRequest({
					base,
					request: req
				});

				if (manifest_error) {
					console.error(colors.bold().red(manifest_error.message));

					const error_page = load_error_page(svelte_config);

					/** @param {{ status: number; message: string }} opts */
					const error_template = ({ status, message }) => {
						return error_page
							.replace(/%sveltekit\.status%/g, String(status))
							.replace(/%sveltekit\.error\.message%/g, message);
					};

					res.writeHead(500, {
						'Content-Type': 'text/html; charset=utf-8'
					});
					res.end(
						error_template({ status: 500, message: manifest_error.message ?? 'Invalid routes' })
					);

					return;
				}

				// TODO routing is slightly more involved than this — need to account for `/_app/env.js`, `__data.json` etc.
				// The logic in `respond.js` uses an `SSRManifest` rather than the `ManifestData`, but could still
				// probably be unified somehow
				const route = manifest_data.routes.find((route) =>
					route.pattern.exec(/** @type {string} */ (req.url))
				);

				const environment =
					/** @type {import('vite').DevEnvironment & { dispatchFetch: (request: Request) => Promise<Response> }} */ (
						vite.environments[route?.environment ?? 'ssr']
					);

				const rendered = await environment.dispatchFetch(request);

				if (rendered.status === 404) {
					// @ts-expect-error
					serve_static_middleware.handle(req, res, () => {
						setResponse(res, rendered);
					});
				} else {
					setResponse(res, rendered);
				}
			} catch (e) {
				const error = coalesce_to_error(e);
				res.statusCode = 500;
				res.end(fix_stack_trace(error));
			}
		});
	};
}

/**
 * @param {import('connect').Server} server
 */
function remove_static_middlewares(server) {
	const static_middlewares = ['viteServeStaticMiddleware', 'viteServePublicMiddleware'];
	for (let i = server.stack.length - 1; i > 0; i--) {
		// @ts-expect-error using internals
		if (static_middlewares.includes(server.stack[i].handle.name)) {
			server.stack.splice(i, 1);
		}
	}
}

/**
 * Determine if a file is being requested with the correct case,
 * to ensure consistent behaviour between dev and prod and across
 * operating systems. Note that we can't use realpath here,
 * because we don't want to follow symlinks
 * @param {string} file
 * @param {string} assets
 * @returns {boolean}
 */
function has_correct_case(file, assets) {
	if (file === assets) return true;

	const parent = path.dirname(file);

	if (fs.readdirSync(parent).includes(path.basename(file))) {
		return has_correct_case(parent, assets);
	}

	return false;
}
