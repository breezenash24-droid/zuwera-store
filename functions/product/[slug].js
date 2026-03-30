// Serve product.html for /product/:slug URLs
// This bypasses CF Pages' pretty URL redirect that conflicts with _redirects rewrites
export async function onRequest(context) {
  const url = new URL(context.request.url);
  // Rewrite to product.html, preserving the original URL for client-side slug extraction
  url.pathname = '/product.html';
  return context.env.ASSETS.fetch(url);
}
