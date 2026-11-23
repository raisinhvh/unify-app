/**
 * Applies the app icon and Windows version strings to the packaged
 * executable.
 *
 * electron-builder's built-in executable editing downloads the winCodeSign
 * archive to get rcedit. That archive contains macOS symbolic links, and
 * extracting it fails on Windows unless the user has symlink rights (Developer
 * Mode or an elevated shell). Setting `signAndEditExecutable: false` in
 * electron-builder.yml skips that download; this hook does the same edit with
 * the rcedit npm package.
 */
const path = require('node:path');

module.exports = async function afterPack(context) {
  if (context.electronPlatformName !== 'win32') return;

  const { appInfo, projectDir } = context.packager;
  const executable = path.join(context.appOutDir, `${appInfo.productFilename}.exe`);
  const version = appInfo.version;

  const { rcedit } = await import('rcedit');
  await rcedit(executable, {
    icon: path.join(projectDir, 'build', 'icon.ico'),
    'file-version': version,
    'product-version': version,
    'version-string': {
      CompanyName: 'raisinhvh',
      FileDescription: 'Unify',
      ProductName: 'Unify',
      LegalCopyright: 'Copyright © 2026 raisinhvh',
      InternalName: 'Unify',
      OriginalFilename: 'Unify.exe',
    },
  });
};
