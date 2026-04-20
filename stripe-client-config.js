(function () {
  var stripeConfigPromise = null;

  async function fetchStripeConfig() {
    var response = await fetch('/api/stripe-config', {
      method: 'GET',
      headers: { Accept: 'application/json' },
      credentials: 'same-origin'
    });

    var data = null;
    try {
      data = await response.json();
    } catch (_) {}

    if (!response.ok || !data || typeof data.publishableKey !== 'string' || !/^pk_(test|live)_/.test(data.publishableKey)) {
      throw new Error((data && data.error) || 'Unable to load Stripe configuration.');
    }

    var isTestMode = /^pk_test_/.test(data.publishableKey);
    window.__ZW_STRIPE_MODE__ = isTestMode ? 'test' : 'live';
    document.querySelectorAll('[data-stripe-test-banner]').forEach(function (banner) {
      banner.classList.toggle('is-visible', isTestMode);
    });

    return data;
  }

  window.zwGetStripeConfig = function zwGetStripeConfig() {
    if (!stripeConfigPromise) {
      stripeConfigPromise = fetchStripeConfig().catch(function (error) {
        stripeConfigPromise = null;
        throw error;
      });
    }
    return stripeConfigPromise;
  };

  window.zwGetStripePublishableKey = async function zwGetStripePublishableKey() {
    var config = await window.zwGetStripeConfig();
    return config.publishableKey;
  };
})();
