import {
	DevEnvironment,
	BuildEnvironment,
	createServerHotChannel,
	createServerModuleRunner
} from 'vite';

export const AsyncFunction = /** @type {typeof Function} */ (async function () {}.constructor);

export const asyncFunctionDeclarationPaddingLineCount = /** #__PURE__ */ (() => {
	const body = '/*code*/';
	const source = new AsyncFunction('a', 'b', body).toString();
	return source.slice(0, source.indexOf(body)).split('\n').length - 1;
})();

class NodeDevEnvironment extends DevEnvironment {
	/** @type {{ entrypoint: string }} */
	#options;

	/** @type {import('vite/module-runner').ModuleRunner} */
	#runner;

	/**
	 * @param {string} name
	 * @param {import('vite').ResolvedConfig} config
	 * @param {{ entrypoint: string }} options
	 */
	constructor(name, config, options) {
		super(name, config, {
			hot: createServerHotChannel(),
			runner: {
				processSourceMap(map) {
					// this assumes that "new AsyncFunction" is used to create the module
					return Object.assign({}, map, {
						mappings: ';'.repeat(asyncFunctionDeclarationPaddingLineCount) + map.mappings
					});
				}
			}
		});

		this.#options = options;
		this.#runner = createServerModuleRunner(this);
	}

	/** @param {Request} request */
	async dispatchFetch(request) {
		const entrypoint = await this.#runner.import(this.#options.entrypoint);
		return entrypoint.default.fetch(request);
	}
}

/**
 * @param {{ entrypoint: string }} options
 * @returns {import('vite').EnvironmentOptions}
 */
export function createNodeEnvironment(options) {
	return {
		dev: {
			createEnvironment(name, config) {
				return new NodeDevEnvironment(name, config, options);
			}
		},
		build: {
			createEnvironment(name, config) {
				return new BuildEnvironment(name, config);
			}
		}
	};
}
