// Shared Supabase client initialiser — loaded deferred after supabase.min.js.
// Runs before DOMContentLoaded so all deferred page scripts have window.sb available.
(function () {
  if (typeof supabase === 'undefined' || window.sb) return;
  window.sb = supabase.createClient(
    'https://qfgnrsifcwdubkolsgsq.supabase.co',
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFmZ25yc2lmY3dkdWJrb2xzZ3NxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzMwMDgzMTUsImV4cCI6MjA4ODU4NDMxNX0.wthoTJEdQhLKnrTwq7nuzAB3Q3FV5rOGVcyi5v1jyLY',
    {
      auth: { persistSession: true, storageKey: 'zuwera-auth', flowType: 'implicit' },
      global: { headers: { 'X-Client-Info': 'zuwera-store' } }
    }
  );
})();
