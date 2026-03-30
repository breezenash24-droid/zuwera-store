// Serve product.html for /product/:slug URLs
// Follow ASSETS redirect internally to bypass CF Pages pretty URL redirect
export async function onRequest(context) {
  const url = new URL(context.request.url);
  url.pathname = '/product.html';
  const response = await context.env.ASSETS.fetch(url);

  // ASSETS may return a 301 redirect due to pretty URLs (/product.html -> /product)
  // Follow it internally and return the final content as a 200
  if (response.status >= 300 && response.status < 400) {
    const location = response.headers.get('location');
    if (location) {
      const redirectUrl = new URL(location, url);
      const finalResponse = await context.env.ASSETS.fetch(redirectUrl);
      return new Response(finalResponse.body, {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' }
      });
    }
  }

  // If no redirect, return the response directly
  return new Response(response.body, {
    status: 200,
    headers: { 'content-type': 'text/html; charset=utf-8' }
  });
}
