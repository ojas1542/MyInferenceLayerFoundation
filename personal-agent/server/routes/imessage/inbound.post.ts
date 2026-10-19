// The eve/nuxt module only proxies /eve/v1/** to the eve server, so custom
// channel routes are not reachable on the app origin. Forward the imessage
// channel's inbound route (agent/channels/imessage.ts) the same way, using
// the eve origin the module records in EVE_BASE_URL. The channel itself
// checks the internal API secret.
export default defineEventHandler((event) => {
  const origin = process.env.EVE_BASE_URL?.replace(/\/$/, "");
  if (!origin) {
    throw createError({
      statusCode: 503,
      statusMessage: "The eve server is not available",
    });
  }

  return proxyRequest(event, `${origin}/imessage/inbound`);
});
