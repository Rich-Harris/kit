import { Server } from '../../../runtime/server/index.js';
import { createReadableStream } from '@sveltejs/kit/node';
import { from_fs } from '../../../utils/filesystem.js';
import { set_assets } from '__sveltekit/paths';
import { assets, env, manifest } from '__sveltekit/environment_context';

// TODO feels like a lot of this is just boilerplate — adapters probably
// shouldn't have to worry about `set_assets` and whatnot, just `read`,
// and maybe setting `env` in scenarios where env vars exist on
// a request context, e.g. Cloudflare Workers
set_assets(assets);

const server = new Server(manifest);

await server.init({
	env,
	read: (file) => createReadableStream(from_fs(file))
});

export default {
	/**
	 * This fetch handler is the entrypoint for the environment.
	 * @param {Request} request
	 */
	fetch: async (request) => {
		console.log('Request in Node environment');

		return server.respond(request, {
			getClientAddress: () => {
				// TODO maybe this is a prod-only thing, and adapters don't have to worry about it in dev?
				return 'TODO';
			}
		});
	}
};
