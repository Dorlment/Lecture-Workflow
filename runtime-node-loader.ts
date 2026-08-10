import type { RuntimeNodeModuleLoader } from './companion-process-types';

export type RuntimeNodeRequire = (moduleId: string) => unknown;

export function createRuntimeNodeModuleLoader(
	loadModule: RuntimeNodeRequire = resolveRuntimeNodeRequire(),
): RuntimeNodeModuleLoader {
	return {
		load(moduleId) {
			return loadModule(moduleId);
		},
	};
}

function resolveRuntimeNodeRequire(): RuntimeNodeRequire {
	return (moduleId) => {
		const runtimeWindow = window as Window & {
			require?: RuntimeNodeRequire;
		};
		const runtimeRequire = runtimeWindow.require;
		if (typeof runtimeRequire !== 'function') {
			throw new RuntimeNodeLoaderError();
		}
		return runtimeRequire(moduleId);
	};
}

export class RuntimeNodeLoaderError extends Error {
	constructor() {
		super('The desktop Node runtime is unavailable.');
		this.name = 'RuntimeNodeLoaderError';
	}
}
