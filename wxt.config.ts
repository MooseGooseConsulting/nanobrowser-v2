import { defineConfig } from 'wxt';
import tailwindcss from '@tailwindcss/vite';

// Public half of the RSA-2048 keypair whose private half lives OUTSIDE this repo at
// ~/.config/nanobrowser/extension-key.pem. Pins the extension ID across unpacked reloads
// so the native-messaging host registration survives rebuilds.
const EXTENSION_KEY =
  'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAsTmqp12xu1sNiMj6L3sRHJdr3af02Zg9iY57qy8EKESPkB5a/iPb+Gw6PHp4Ig9qHfG6C7fbVQuoavkhS5oi17mttZqobteRvyx8Oxv5b312up8X8fbwOhzocRinHop08a7rNcK4q9oacBcJYjWt84HWAOLM4pq+RMMm3zrXcDN/EeoUFqCXDo2h9ibzO6ec4EfcvkkPIfdTp/yZpvl5jiMfkXMuMNH4454z23BerfTKSo8hCqR4sschuIa07mvX+AhtT+zdgNL8Zy/H+a+hSMfbAoss7a6cxcpwYQppjeGSrlx8VoFmX9viPOVDUa96ISKIIwkc62FajvMGEX/BjwIDAQAB';

export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  srcDir: '.',
  // We never let WXT launch a browser: the target is the user's real Chrome,
  // loaded once via "Load unpacked" from .output/chrome-mv3.
  webExt: {
    disabled: true,
  },
  vite: () => ({
    plugins: [tailwindcss()],
  }),
  manifest: () => ({
    name: 'nanobrowser',
    description: 'Leader/Follower browser agent in the side panel.',
    key: EXTENSION_KEY,
    permissions: [
      'sidePanel',
      'tabs',
      'scripting',
      'storage',
      'userScripts',
      'nativeMessaging',
      'debugger',
      // Follower tool `download` (O-05's assumption): chrome.downloads is otherwise absent
      // and PageDriver.download refuses with a clear error.
      'downloads',
    ],
    host_permissions: ['<all_urls>'],
    side_panel: {
      default_path: 'sidepanel.html',
    },
    action: {},
    // Opens the panel from the keyboard (R-05): `_execute_action` is the reserved name
    // Chrome maps to the toolbar action itself, so no listener is needed for it to work.
    commands: {
      _execute_action: {
        suggested_key: { default: 'Ctrl+Shift+Y' },
      },
    },
  }),
});
