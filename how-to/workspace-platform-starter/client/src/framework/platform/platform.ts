import {
	getCurrentSync,
	init as workspacePlatformInit,
	type BrowserInitConfig
} from "@openfin/workspace-platform";
import * as actionsProvider from "../actions";
import * as analyticsProvider from "../analytics";
import * as appProvider from "../apps";
import * as auth from "../auth";
import * as authFlow from "../auth-flow";
import * as conditionsProvider from "../conditions";
import * as connectionProvider from "../connections";
import * as endpointProvider from "../endpoint";
import * as favoriteProvider from "../favorite";
import * as initOptionsProvider from "../init-options";
import * as lifecycleProvider from "../lifecycle";
import * as loggerProvider from "../logger-provider";
import * as menusProvider from "../menu";
import * as modules from "../modules";
import { getManifestCustomSettings, getSettings } from "../settings";
import type { ModuleHelpers } from "../shapes/module-shapes";
import type { CustomSettings } from "../shapes/setting-shapes";
import * as shareProvider from "../share";
import { getThemes, notifyColorScheme, supportsColorSchemes } from "../themes";
import { isEmpty, randomUUID } from "../utils";
import * as versionProvider from "../version";
import * as lowCodeIntegrationProvider from "../workspace/low-code-integrations";
import { getDefaultWindowOptions } from "./browser";
import { interopOverride } from "./interopbroker";
import { overrideCallback } from "./platform-override";
import * as platformSplashProvider from "./platform-splash";
import { PLATFORM_VERSION } from "./platform-version";

const logger = loggerProvider.createLogger("Platform");

/**
 * Initialize the platform.
 * @returns True if the platform was initialized.
 */
export async function init(): Promise<boolean> {
	await platformSplashProvider.updateProgress("Platform");

	const customSettings = await getManifestCustomSettings();

	const isValid = await authFlow.init(
		customSettings.authProvider,
		async () => setupPlatform(customSettings),
		logger,
		true
	);

	if (!isValid) {
		logger.error(
			"The platform cannot startup as there was a problem with the initialization of the auth flow."
		);
	}

	return isValid;
}

/**
 * Setup the platform.
 * @param manifestSettings The custom setting to use for setting up the platform.
 * @returns True if the platform setup was successful.
 */
async function setupPlatform(manifestSettings: CustomSettings): Promise<boolean> {
	// Load the init options from the initial manifest
	// and notify any actions with the after auth lifecycle
	await modules.init(randomUUID());

	await platformSplashProvider.updateProgress("Init Options");

	const helpers: ModuleHelpers = modules.getDefaultHelpers();

	await initOptionsProvider.init(manifestSettings?.initOptionsProvider, helpers, "after-auth");

	// We reload the settings now that endpoints have been configured.
	const customSettings: CustomSettings = await getSettings();

	await platformSplashProvider.updateProgress("Logger");

	await loggerProvider.init(customSettings?.loggerProvider, helpers);

	logger.info("Initializing Core Services");

	await platformSplashProvider.updateProgress("Endpoints");

	await endpointProvider.init(customSettings?.endpointProvider, helpers);

	await platformSplashProvider.updateProgress("Versioning");

	const runtimeVersion = await fin.System.getVersion();

	await versionProvider.init(customSettings?.versionProvider, endpointProvider);
	versionProvider.setVersion("runtime", runtimeVersion);
	try {
		const rvmInfo = await fin.System.getRvmInfo();
		versionProvider.setVersion("rvm", rvmInfo.version);
	} catch {
		logger.warn("RVM version information unavailable.");
	}
	versionProvider.setVersion("platformClient", PLATFORM_VERSION);

	await platformSplashProvider.updateProgress("Connections");
	await connectionProvider.init(customSettings?.connectionProvider);

	await platformSplashProvider.updateProgress("Menus");
	await menusProvider.init(customSettings?.menusProvider, helpers, customSettings?.platformProvider?.rootUrl);

	await platformSplashProvider.updateProgress("Analytics");
	await analyticsProvider.init(customSettings?.analyticsProvider, helpers);

	await platformSplashProvider.updateProgress("Apps");
	await appProvider.init(customSettings?.appProvider, endpointProvider);

	await platformSplashProvider.updateProgress("Conditions");
	await conditionsProvider.init(customSettings?.conditionsProvider, helpers);
	conditionsProvider.registerCondition(
		"authenticated",
		async () => auth.isAuthenticationEnabled() && !(await auth.isAuthenticationRequired()),
		false
	);
	conditionsProvider.registerCondition("sharing", async () => shareProvider.isShareEnabled(), false);
	conditionsProvider.registerCondition("themed", async () => supportsColorSchemes(), false);

	await platformSplashProvider.updateProgress("Lifecycles");
	await lifecycleProvider.init(customSettings?.lifecycleProvider, helpers);

	const sharingEnabled = customSettings.platformProvider?.sharing ?? true;
	if (sharingEnabled) {
		await platformSplashProvider.updateProgress("Sharing");
		await shareProvider.init({ enabled: sharingEnabled });
	}

	if (!isEmpty(customSettings?.favoriteProvider) && (customSettings?.favoriteProvider.enabled ?? true)) {
		await platformSplashProvider.updateProgress("Favorites");
		await favoriteProvider.init(
			customSettings?.favoriteProvider,
			await versionProvider.getVersionInfo(),
			endpointProvider
		);
	}

	logger.info("Initializing platform");
	const browser: BrowserInitConfig = {};

	if (!isEmpty(customSettings?.browserProvider)) {
		browser.defaultWindowOptions = await getDefaultWindowOptions(customSettings.browserProvider);
	}
	if (!isEmpty(customSettings?.browserProvider?.defaultPageOptions)) {
		browser.defaultPageOptions = customSettings.browserProvider?.defaultPageOptions;
	}
	if (!isEmpty(customSettings?.browserProvider?.defaultViewOptions)) {
		browser.defaultViewOptions = customSettings.browserProvider?.defaultViewOptions;
	}

	logger.info("Specifying following browser options", browser);

	const customActions = await actionsProvider.init(customSettings?.actionsProvider, helpers);
	const theme = await getThemes();

	await lowCodeIntegrationProvider.init(customSettings?.lowCodeIntegrationProvider);
	const integrations = await lowCodeIntegrationProvider.register();

	const platform = getCurrentSync();
	await platform.once("platform-api-ready", async () => {
		logger.info("Platform API Ready");
		fin.me.interop = fin.Interop.connectSync(fin.me.uuid, {});
		await notifyColorScheme();
	});

	await workspacePlatformInit({
		browser,
		theme,
		customActions,
		interopOverride,
		overrideCallback: async (platformConstructor) =>
			overrideCallback(
				platformConstructor,
				customSettings?.platformProvider,
				customSettings?.browserProvider,
				await versionProvider.getVersionInfo()
			),
		integrations,
		analytics: customSettings?.analyticsProvider?.sendToOpenFin ? { sendToOpenFin: true } : undefined
	});
	return true;
}

/**
 * Closedown the platform.
 */
export async function closedown(): Promise<void> {
	await shareProvider.closedown();
}
