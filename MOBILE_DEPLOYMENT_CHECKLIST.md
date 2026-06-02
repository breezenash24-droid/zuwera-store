# Mobile Deployment Checklist

Run this before pushing UI changes that affect the storefront:

```bash
npm run deployment-checklist
npm run build
```

Then test the deployed Cloudflare build on a real phone or mobile browser:

1. Open `https://zuwera.store/?test=mobile-check`.
2. Confirm the page source includes `zuwera-deployment`.
3. Open the hamburger menu on the homepage.
4. Confirm the menu covers the full screen and all links are visible or scrollable.
5. Close the menu with the close button, backdrop tap, and Escape key on desktop.
6. Repeat the hamburger test on the product page.
7. Repeat the hamburger test on the collection page.
8. Open Bag when empty and confirm the modal opens without page jump.
9. Open Login and confirm the page does not scroll behind the modal.
10. Open checkout and confirm the Pay Now button is reachable on mobile.
11. If the checkout banner says test mode, use Stripe test cards only.
12. Open the product Size Guide and confirm it opens as a modal.
13. Open the homepage footer Size Guide and confirm it opens `sizeguide.html`.

If a fix does not show up on mobile, run:

```bash
npm run bump-cache
```

Then commit the changed version numbers and redeploy.
