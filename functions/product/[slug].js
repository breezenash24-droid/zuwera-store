// Serve product.html for /product/:slug URLs
// Follow ASSETS redirect internally to bypass CF Pages pretty URL redirect
export async function onRequest(context) {
  const url = new URL(context.request.url);
  url.pathname = '/product.html';
  let response = await context.env.ASSETS.fetch(url);

  // ASSETS may return a 301 redirect due to pretty URLs (/product.html -> /product)
  // Follow it internally and return the final content as a 200
  if (response.status >= 300 && response.status < 400) {
    const location = response.headers.get('location');
    if (location) {
      const redirectUrl = new URL(location, url);
      response = await context.env.ASSETS.fetch(redirectUrl);
    }
  }

  // Read full HTML and return as new 200 response to avoid stream truncation
  const html = await response.text();
  return new Response(html, {
    status: 200,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'public, max-age=0, must-revalidate'
    }
  });
}
