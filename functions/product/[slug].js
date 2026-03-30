// Serve product.html for /product/:slug URLs
// This bypasses CF Pages' pretty URL redirect that conflicts with _redirects rewrites
export async function onRequest(context) {
  const url = new URL(context.request.url);
  // Fetch /product (not /product.html) so ASSETS serves content without pretty URL redirect
  url.pathname = '/product';
  return context.env.ASSETS.fetch(url);
}
