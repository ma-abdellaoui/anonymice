// PLATFORM SEAM — Chrome / Chromium, MV3, 111+.
//
// Loaded first in the ISOLATED world, before core/content/*. Everything that
// differs between browsers lives here and nowhere else; core/ must never
// branch on the platform. See platform/README.md for the four seams.

self.anonymicePlatform = {
  name: 'chrome',

  // ① MAIN-world injection. Chrome declares it in the manifest
  // (`"world": "MAIN"`), so the shims are installed before the page's own
  // scripts run. A platform without this cannot offer control point ③ at full
  // strength — do not paper over that, document it.
  mainWorld: 'manifest',

  // ② Clipboard. Chrome carries unsanitized custom formats, so provenance can
  // ride along with the tokens. Where this is false, the copy path still works
  // — it just always takes the slow "no provenance" branch on paste.
  clipboard: {
    customFormats: true,
    provenanceType: 'application/x-anonymice',
    provenanceTypeAsync: 'web application/x-anonymice'
  },

  // ③ Managed policy delivery (the trust list users must not be able to edit).
  policy: {
    read: async () => {
      try { return (await chrome.storage.managed.get(null)) ?? {}; }
      catch { return {}; }   // no enterprise policy present — dev default
    }
  },

  // ④ Extension API namespace.
  runtime: chrome.runtime
};
