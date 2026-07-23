/* =========================================================
   emailService.js — Client Hub outbound email (MODULAR STUB)
   Loaded before the main hub script. In SIMULATE it builds + logs a
   clean payload (the deliverable, so it's trivially wired later). In
   LIVE it POSTs to the Bunny Edge Script /hub/notify, which injects the
   studio's provider credentials server-side from env vars.

   NO provider credentials or secrets ever live in this file.
   ========================================================= */
(function (global) {
  const ADMIN_KEY_SS = 'lsc_hub_admin_key'; // admin bearer, set once after PIN (live only)

  // Build the onboarding link into the hub. Honours HUB_CONFIG.basePath so a
  // subdomain move doesn't break invite URLs; falls back to the current path.
  function inviteUrl(cfg, token) {
    const base = (cfg.basePath && cfg.basePath !== './')
      ? cfg.basePath
      : (location.origin + location.pathname.replace(/[^/]*$/, ''));
    return base + 'index.html?invite=' + encodeURIComponent(token || '');
  }

  // LIVE dispatch through the Edge Script. Admin-authed (notify is admin-only).
  async function dispatch(cfg, body) {
    const res = await fetch(cfg.edgeBase + '/hub/notify', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + (sessionStorage.getItem(ADMIN_KEY_SS) || '')
      },
      body: JSON.stringify(body)
    });
    if (!res.ok) throw new Error('/hub/notify → ' + res.status);
    return res.json().catch(() => ({}));
  }

  const emailService = {
    // Studio → client: first-time invitation with the 4-digit code + onboarding link.
    async sendInvitation(project, cfg) {
      const payload = {
        kind: 'invitation',
        to: project.clientEmail || '',
        url: inviteUrl(cfg, project.inviteToken),
        code: project.clientCode || '',
        project: project.name || project.upid || project.id
      };
      console.log('%c[emailService] sendInvitation', 'color:#8FA89B;font-weight:bold', payload);
      if (cfg.mode === 'live') {
        try { await dispatch(cfg, { kind: 'invitation', projectId: project.id, to: payload.to }); }
        catch (e) { console.error('[emailService] live invitation failed:', e); }
      }
      return payload; // TODO(live provider): the Edge Script /hub/notify performs the real send.
    },

    // Studio → client: reset / resend the 4-digit code (Admin Master Reset, or "Forgot code?").
    async sendCodeReset(project, cfg) {
      const payload = {
        kind: 'reset',
        to: project.clientEmail || '',
        url: inviteUrl(cfg, project.inviteToken),
        code: project.clientCode || '',
        project: project.name || project.upid || project.id
      };
      console.log('%c[emailService] sendCodeReset', 'color:#D9A441;font-weight:bold', payload);
      if (cfg.mode === 'live') {
        try { await dispatch(cfg, { kind: 'reset', projectId: project.id, to: payload.to }); }
        catch (e) { console.error('[emailService] live reset failed:', e); }
      }
      return payload;
    }
  };

  global.emailService = emailService;
})(window);
