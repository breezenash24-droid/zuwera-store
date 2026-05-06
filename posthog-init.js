/**
 * PostHog analytics for Zuwera
 *
 * Initialises PostHog, identifies users when they sign in via Supabase,
 * and exposes window.zwTrack(event, props) for custom event capture from
 * any page.  Include this script in <head> on every page.
 */

/* ── Snippet loader (minified PostHog array.js bootstrap) ── */
!function(t,e){var o,n,p,r;e.__SV||(window.posthog=e,e._i=[],e.init=function(i,s,a){function g(t,e){var o=e.split('.');2==o.length&&(t=t[o[0]],e=o[1]),t[e]=function(){t.push([e].concat(Array.prototype.slice.call(arguments,0)))}}(p=t.createElement('script')).type='text/javascript',p.crossOrigin='anonymous',p.async=!0,p.src=s.api_host.replace('.i.posthog.com','-assets.i.posthog.com')+'/static/array.js',(r=t.getElementsByTagName('script')[0]).parentNode.insertBefore(p,r);var u=e;for(s&&s.name?e=e[a=s.name]:(a='posthog',e=e[a]||(e[a]=[])),u.__loaded||(u.__loaded=!0,u.set_config(s)),u._i.push([i,s,a]),n=0;n<['capture','identify','alias','on','set','register','register_once','unregister','opt_out_capturing','has_opted_out_capturing','opt_in_capturing','reset','isFeatureEnabled','onFeatureFlags','reloadFeatureFlags','addGroup','setPersonPropertiesForFlags','resetGroupPropertiesForFlags','setGroupPropertiesForFlags','createEarlyAccessFeatureCallback','getEarlyAccessFeatures','updateEarlyAccessFeatureEnrollment','getActiveMatchingSurveys','getSurveys','getNextSurveyStep'].length;n++)g(e,['capture','identify','alias','on','set','register','register_once','unregister','opt_out_capturing','has_opted_out_capturing','opt_in_capturing','reset','isFeatureEnabled','onFeatureFlags','reloadFeatureFlags','addGroup','setPersonPropertiesForFlags','resetGroupPropertiesForFlags','setGroupPropertiesForFlags','createEarlyAccessFeatureCallback','getEarlyAccessFeatures','updateEarlyAccessFeatureEnrollment','getActiveMatchingSurveys','getSurveys','getNextSurveyStep'][n]);e._i.push([i,s,a])}),e.__SV=1}(document,window.posthog||[]);

// The PostHog stub's init() calls u.set_config() on the parent array, but that method
// is only added to the named sub-instance — not to the parent — causing a TypeError
// that prevents the rest of this script from running.  Add a no-op so init() succeeds.
if (window.posthog && !window.posthog.set_config) {
  window.posthog.set_config = function() {};
}

posthog.init('phc_mCL2GmGPncq5Twg7vK6FesuQHQZVTojTxHTpc4Bwp9yT', {
  api_host:        'https://us.i.posthog.com',
  defaults:        '2026-01-30',
  person_profiles: 'identified_only',  // only create profiles for signed-in users
  autocapture:     true,               // clicks, form submits, page views
  capture_pageview: true,
  capture_pageleave: true,
});

/* ── Convenience wrapper ── */
window.zwTrack = function(event, props) {
  try { posthog.capture(event, props || {}); } catch (_) {}
};

/* ── Identify users when Supabase auth is ready ── */
(function identifyOnAuth() {
  function tryIdentify() {
    var sb = window.sb || window._sb;
    if (!sb || !sb.auth) return false;
    sb.auth.onAuthStateChange(function(event, session) {
      if (session && session.user) {
        var u    = session.user;
        var meta = u.user_metadata || {};
        posthog.identify(u.id, {
          email:      u.email   || '',
          name:       meta.full_name || meta.name || '',
          created_at: u.created_at   || '',
        });
        if (event === 'SIGNED_IN') zwTrack('user_signed_in', { email: u.email });
        if (event === 'SIGNED_UP') zwTrack('user_signed_up', { email: u.email });
      } else {
        posthog.reset();
      }
    });
    return true;
  }

  // Supabase client might not exist yet — retry until it appears
  if (!tryIdentify()) {
    var _tries = 0;
    var _poll  = setInterval(function() {
      if (tryIdentify() || ++_tries > 20) clearInterval(_poll);
    }, 250);
  }
})();
