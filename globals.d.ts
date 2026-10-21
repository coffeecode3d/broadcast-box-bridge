declare const VencordNative: {
    pluginHelpers: Record<string, unknown>;
} | undefined;

/**
 * The BetterDiscord bundle receives Electron through BetterDiscord's remote
 * require. Only the tiny surface the plugin uses is declared here.
 */
declare module "electron" {
    export const shell: {
        openPath(path: string): Promise<string>;
    };
}
