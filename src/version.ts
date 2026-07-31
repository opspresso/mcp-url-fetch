/**
 * What this server calls itself.
 *
 * Its own file because both ends need it and they cannot reach each other:
 * `server.ts` tells a client what it connected to, and `fetchContent.ts` tells
 * every site it fetches the same thing in a User-Agent. Importing the latter
 * from the former is the only edge that exists, so the name has to sit under
 * both rather than beside one.
 *
 * `SERVER_VERSION` restates package.json's `version`. A test pins the two
 * together: nothing else would notice them drifting, and what a client is told
 * it is talking to would quietly stop being true.
 */

export const SERVER_NAME = "mcp-url-fetch";
export const SERVER_VERSION = "1.1.2";
